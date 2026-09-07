"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Globe,
  Lock,
  Trash2,
  UserMinus,
  Users,
} from "lucide-react";
import {
  api,
  ApiError,
  type CreatedInvite,
  type GrantableRole,
  type InviteView,
  type MemberView,
  type Role,
  type Visibility,
} from "@/lib/api/client";
import { Button, FormError, Spinner } from "@/components/ui";

/**
 * People & sharing for one board.
 *
 * A popover anchored to its trigger, matching ExportMenu — same keyboard
 * isolation, same outside-click close, same focus return. It is NOT a modal:
 * the canvas stays visible and usable behind it, and a real modal would need a
 * focus trap, a backdrop and `aria-modal` for no gain here.
 *
 * WHO SEES WHAT:
 *   - The member list is visible to ANY member. You can already see everyone's
 *     cursor and presence avatar on the canvas, so the list discloses nothing
 *     new, and hiding it would make the two views disagree.
 *   - Sharing — visibility, invites, role changes, removal — is OWNER ONLY, and
 *     those controls are not rendered at all for anyone else. The API enforces
 *     it regardless; this just avoids offering a guaranteed 403.
 */

const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  EDITOR: "Editor",
  VIEWER: "Viewer",
};

const EXPIRY_CHOICES = [
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
] as const;

function relativeExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${Math.max(1, hours)}h left`;
  return `${Math.round(hours / 24)}d left`;
}

export function SharePanel({ slug, role }: { slug: string; role: Role }) {
  const isOwner = role === "OWNER";

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [invites, setInvites] = useState<InviteView[] | null>(null);
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Invite form
  const [inviteRole, setInviteRole] = useState<GrantableRole>("EDITOR");
  const [expiryHours, setExpiryHours] = useState<number>(24);
  const [multiUse, setMultiUse] = useState(false);
  const [maxUses, setMaxUses] = useState(10);
  /** The one moment the raw token exists. Cleared when the panel closes. */
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, room] = await Promise.all([
        api.listMembers(slug),
        api.getRoom(slug),
      ]);
      setMembers(m);
      setVisibility(room.visibility);
      // Invites are owner-only; asking as a non-owner would be a guaranteed 403.
      if (isOwner) setInvites(await api.listInvites(slug));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load sharing info.");
    }
  }, [slug, isOwner]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /**
   * KEYBOARD ISOLATION, identical to ExportMenu and for the same reason: the
   * canvas listens on `window`, so without a capture-phase listener that stops
   * propagation, typing an invite's use-count would also drive the board — `r`
   * would switch to the rectangle tool, Delete would delete a selection, and
   * Escape would clear it as well as closing this panel.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Focus into the panel on open, back to the trigger on close.
  useEffect(() => {
    if (open) panelRef.current?.focus();
    else {
      // Dropping the raw token on close is deliberate: it is unrecoverable
      // anyway, and leaving it on screen invites the belief it can be re-read.
      setCreated(null);
      setCopied(false);
      triggerRef.current?.focus();
    }
  }, [open]);

  async function setBoardVisibility(next: Visibility): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const updated = await api.updateRoom(slug, { visibility: next });
      setVisibility(updated.visibility);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? "Only the board owner can change this."
            : err.message
          : "Couldn't change visibility.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function createInvite(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const invite = await api.createInvite(slug, {
        role: inviteRole,
        expiresInHours: expiryHours,
        maxUses: multiUse ? maxUses : 1,
      });
      setCreated(invite);
      setInvites((list) => [invite, ...(list ?? [])]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create an invite.");
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteLink(): Promise<void> {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.acceptUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions). The link is shown
      // in a selectable field, so it can still be copied by hand.
    }
  }

  async function revoke(inviteId: string): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await api.revokeInvite(slug, inviteId);
      setInvites((list) =>
        (list ?? []).map((i) =>
          i.id === inviteId
            ? { ...i, revokedAt: new Date().toISOString(), active: false }
            : i,
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't revoke that invite.");
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(member: MemberView, next: GrantableRole): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await api.updateMemberRole(slug, member.userId, next);
      setMembers((list) =>
        (list ?? []).map((m) => (m.userId === member.userId ? { ...m, role: next } : m)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change that role.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: MemberView): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await api.removeMember(slug, member.userId);
      setMembers((list) => (list ?? []).filter((m) => m.userId !== member.userId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that member.");
    } finally {
      setBusy(false);
    }
  }

  const activeInvites = (invites ?? []).filter((i) => i.active);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="People and sharing"
        aria-label="People and sharing"
        aria-expanded={open}
        data-testid="share-trigger"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100"
      >
        <Users className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>

      {open && (
        <div
          ref={panelRef}
          tabIndex={-1}
          data-testid="share-panel"
          className="absolute right-0 top-10 z-50 flex max-h-[70vh] w-80 flex-col gap-4 overflow-y-auto rounded-xl bg-white p-4 text-left shadow-lg ring-1 ring-slate-900/10 outline-none"
        >
          {error && <FormError message={error} />}

          {/* ── Sharing (owner only) ─────────────────────────────────── */}
          {isOwner && (
            <section className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Access
              </h2>
              <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                <VisibilityButton
                  active={visibility === "PRIVATE"}
                  disabled={busy || visibility === null}
                  onClick={() => void setBoardVisibility("PRIVATE")}
                  icon={<Lock className="h-3.5 w-3.5" strokeWidth={2} />}
                  label="Private"
                  testId="visibility-private"
                />
                <VisibilityButton
                  active={visibility === "LINK"}
                  disabled={busy || visibility === null}
                  onClick={() => void setBoardVisibility("LINK")}
                  icon={<Globe className="h-3.5 w-3.5" strokeWidth={2} />}
                  label="Anyone with the link"
                  testId="visibility-link"
                />
              </div>
              <p className="text-xs text-slate-500">
                {visibility === "LINK"
                  ? "Anyone signed in who has the board link can join and edit."
                  : "Only people you invite can open this board."}
              </p>
            </section>
          )}

          {/* ── Create an invite (owner only) ────────────────────────── */}
          {isOwner && (
            <section className="flex flex-col gap-2 border-t border-slate-100 pt-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Invite link
              </h2>

              {created ? (
                <div
                  data-testid="invite-created"
                  className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200"
                >
                  <p className="text-xs font-medium text-amber-900">
                    Copy this link now — it won&apos;t be shown again.
                  </p>
                  <input
                    readOnly
                    value={created.acceptUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    data-testid="invite-link"
                    className="w-full rounded border border-amber-300 bg-white px-2 py-1 font-mono text-[11px] text-slate-700 outline-none"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      className="px-3 py-1 text-xs"
                      onClick={() => void copyInviteLink()}
                      data-testid="copy-invite"
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-green-600" strokeWidth={2.5} />
                      ) : (
                        <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                      )}
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                    <Button
                      variant="secondary"
                      className="px-3 py-1 text-xs"
                      onClick={() => setCreated(null)}
                    >
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center justify-between gap-2 text-xs text-slate-600">
                    Role
                    <select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as GrantableRole)}
                      data-testid="invite-role"
                      className="rounded border border-slate-300 px-2 py-1 text-xs outline-none"
                    >
                      <option value="EDITOR">Editor</option>
                      <option value="VIEWER">Viewer</option>
                    </select>
                  </label>

                  <label className="flex items-center justify-between gap-2 text-xs text-slate-600">
                    Expires
                    <select
                      value={expiryHours}
                      onChange={(e) => setExpiryHours(Number(e.target.value))}
                      data-testid="invite-expiry"
                      className="rounded border border-slate-300 px-2 py-1 text-xs outline-none"
                    >
                      {EXPIRY_CHOICES.map((c) => (
                        <option key={c.hours} value={c.hours}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center justify-between gap-2 text-xs text-slate-600">
                    Uses
                    <span className="flex items-center gap-2">
                      <select
                        value={multiUse ? "many" : "one"}
                        onChange={(e) => setMultiUse(e.target.value === "many")}
                        data-testid="invite-uses"
                        className="rounded border border-slate-300 px-2 py-1 text-xs outline-none"
                      >
                        <option value="one">Single use</option>
                        <option value="many">Multi-use</option>
                      </select>
                      {multiUse && (
                        <input
                          type="number"
                          min={2}
                          max={1000}
                          value={maxUses}
                          onChange={(e) => setMaxUses(Number(e.target.value))}
                          data-testid="invite-max-uses"
                          className="w-16 rounded border border-slate-300 px-2 py-1 text-xs outline-none"
                        />
                      )}
                    </span>
                  </label>

                  <Button
                    className="px-3 py-1.5 text-xs"
                    disabled={busy}
                    onClick={() => void createInvite()}
                    data-testid="create-invite"
                  >
                    Create invite link
                  </Button>
                </div>
              )}

              {/* Active invites */}
              {invites === null ? (
                <Spinner />
              ) : activeInvites.length === 0 ? (
                <p className="text-xs text-slate-400">No active invite links.</p>
              ) : (
                <ul className="flex flex-col gap-1" data-testid="invite-list">
                  {activeInvites.map((i) => (
                    <li
                      key={i.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium text-slate-700">
                          {ROLE_LABEL[i.role]}
                        </span>
                        <span className="text-slate-500">
                          {relativeExpiry(i.expiresAt)} ·{" "}
                          {Math.max(0, i.maxUses - i.usedCount)} of {i.maxUses} left
                        </span>
                      </span>
                      <button
                        type="button"
                        title="Revoke this invite"
                        aria-label="Revoke this invite"
                        disabled={busy}
                        onClick={() => void revoke(i.id)}
                        data-testid={`revoke-${i.id}`}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={2} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Members (every member sees this) ─────────────────────── */}
          <section className="flex flex-col gap-2 border-t border-slate-100 pt-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              People with access
            </h2>
            {members === null ? (
              <Spinner />
            ) : (
              <ul className="flex flex-col gap-1" data-testid="member-list">
                {members.map((m) => (
                  <li
                    key={m.userId}
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-50"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-slate-700">{m.name}</span>
                      <span className="truncate text-slate-400">{m.email}</span>
                    </span>

                    {/* THE OWNER IS NOT REMOVABLE OR DEMOTABLE. Shown as a
                        static label with no controls, rather than rendering
                        controls that the server would reject — an affordance
                        that cannot act is worse than none. */}
                    {m.isOwner ? (
                      <span
                        data-testid="owner-badge"
                        className="shrink-0 rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-600"
                      >
                        Owner
                      </span>
                    ) : isOwner ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <select
                          value={m.role === "OWNER" ? "EDITOR" : m.role}
                          disabled={busy}
                          onChange={(e) =>
                            void changeRole(m, e.target.value as GrantableRole)
                          }
                          data-testid={`role-${m.userId}`}
                          className="rounded border border-slate-300 px-1.5 py-0.5 text-xs outline-none"
                        >
                          <option value="EDITOR">Editor</option>
                          <option value="VIEWER">Viewer</option>
                        </select>
                        <button
                          type="button"
                          title={`Remove ${m.name}`}
                          aria-label={`Remove ${m.name}`}
                          disabled={busy}
                          onClick={() => void remove(m)}
                          data-testid={`remove-${m.userId}`}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                        >
                          <UserMinus className="h-4 w-4" strokeWidth={2} />
                        </button>
                      </span>
                    ) : (
                      <span className="shrink-0 text-slate-500">{ROLE_LABEL[m.role]}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function VisibilityButton({
  active,
  disabled,
  onClick,
  icon,
  label,
  testId,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      data-testid={testId}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
        active ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:bg-white/60"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

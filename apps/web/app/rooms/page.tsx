"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Plus, X } from "lucide-react";
import { RoomName, ROOM_NAME_MAX } from "@sketchsync/shared";
import { api, ApiError, type RoomSummary } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/AuthProvider";
import { Protected } from "@/lib/auth/Protected";
import { SignOutButton } from "@/lib/auth/SignOutButton";
import { Button, FormError, Spinner } from "@/components/ui";

const ROLE_LABEL: Record<RoomSummary["role"], string> = {
  OWNER: "Owner",
  EDITOR: "Editor",
  VIEWER: "Viewer",
};

function RoomsList() {
  const { user } = useAuth();
  const router = useRouter();

  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  /** Errors from an ACTION the user just took (create / rename). */
  const [error, setError] = useState("");
  /**
   * Failure of the initial LOAD — deliberately separate state.
   *
   * These used to share one variable and `load()` also set `rooms` to `[]` on
   * failure, so a failed fetch rendered the "No boards yet." empty state with a
   * banner over it: a user whose API was down was told they had no boards and
   * offered a Create button. Empty and broken are different facts and now render
   * as different screens.
   */
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  // Inline rename: which row is being edited, and its draft value.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  function startRename(room: RoomSummary): void {
    setError("");
    setEditingId(room.id);
    setDraft(room.name);
  }

  async function saveRename(room: RoomSummary): Promise<void> {
    const parsed = RoomName.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid name");
      return;
    }
    if (parsed.data === room.name) {
      setEditingId(null);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.renameRoom(room.slug, parsed.data);
      setRooms((rs) => (rs ?? []).map((r) => (r.id === room.id ? updated : r)));
      setEditingId(null);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 403
            ? "Only the board owner can rename it."
            : err.message
          : "Couldn't rename the board.",
      );
    } finally {
      setSaving(false);
    }
  }

  const load = useCallback(async () => {
    setError("");
    setLoadError("");
    setRooms(null);
    try {
      setRooms(await api.listRooms());
    } catch (err) {
      // Leave `rooms` null: there is no known list, which is NOT the same as an
      // empty one.
      setLoadError(
        err instanceof ApiError ? err.message : "Couldn't load your boards.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBoard() {
    setError("");
    setCreating(true);
    try {
      const name = `Untitled board`;
      const room = await api.createRoom(name);
      router.push(`/room/${room.slug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create a board.");
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <span className="text-lg font-semibold tracking-tight text-slate-900">
          SketchSync
        </span>
        <div className="flex items-center gap-3">
          {user && <span className="text-sm text-slate-500">{user.name}</span>}
          <SignOutButton />
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-900">Your boards</h1>
          <Button onClick={createBoard} disabled={creating}>
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            {creating ? "Creating…" : "New board"}
          </Button>
        </div>

        {error && <FormError message={error} />}

        {loadError ? (
          <div
            data-testid="rooms-load-error"
            role="alert"
            className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-white py-16 text-center"
          >
            <p className="text-sm font-medium text-slate-900">
              Couldn&apos;t load your boards
            </p>
            <p className="max-w-sm text-sm text-slate-500">{loadError}</p>
            <p className="text-xs text-slate-400">
              Your boards are still there — this is a connection problem.
            </p>
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        ) : rooms === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rooms.length === 0 ? (
          <div
            data-testid="rooms-empty"
            className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center"
          >
            <p className="text-sm text-slate-500">No boards yet.</p>
            <Button onClick={createBoard} disabled={creating}>
              <Plus className="h-4 w-4" strokeWidth={2.5} />
              Create your first board
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rooms.map((room) => (
              <li key={room.id}>
                {editingId === room.id ? (
                  <div className="flex items-center gap-2 rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-900/5">
                    <input
                      autoFocus
                      data-testid="rename-input"
                      value={draft}
                      maxLength={ROOM_NAME_MAX}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(room);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-slate-900/20"
                    />
                    <button
                      type="button"
                      data-testid="rename-save"
                      disabled={saving}
                      onClick={() => void saveRename(room)}
                      aria-label="Save name"
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-green-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                      <Check className="h-4 w-4" strokeWidth={2.5} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel rename"
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                    >
                      <X className="h-4 w-4" strokeWidth={2.5} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-900/5 transition hover:ring-slate-900/15">
                    <button
                      type="button"
                      onClick={() => router.push(`/room/${room.slug}`)}
                      className="min-w-0 flex-1 truncate text-left font-medium text-slate-900"
                    >
                      {room.name}
                    </button>
                    {/* Only the owner may rename (API enforces it; this hides a
                        control that would always 403). */}
                    {room.role === "OWNER" && (
                      <button
                        type="button"
                        data-testid={`rename-${room.slug}`}
                        onClick={() => startRename(room)}
                        aria-label={`Rename ${room.name}`}
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      >
                        <Pencil className="h-4 w-4" strokeWidth={2} />
                      </button>
                    )}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                      {ROLE_LABEL[room.role]}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

export default function RoomsPage() {
  return (
    <Protected>
      <RoomsList />
    </Protected>
  );
}

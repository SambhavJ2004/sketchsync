"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { api, ApiError, type Role } from "@/lib/api/client";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth/AuthProvider";
import { Button, FullScreen, Spinner } from "@/components/ui";

/**
 * Invite acceptance: redeem the token, then land in the board.
 *
 * NOT wrapped in <Protected>. That component bounces an unauthenticated user to
 * `/signin` without a return path, which would lose the token — the one thing
 * this page exists to carry. Auth is handled explicitly below so the token
 * survives the round trip through sign-in.
 *
 * Failures are distinguished BY STATUS, not by message text:
 *   401 -> not signed in      -> /signin?next=/invite/<token>, then back here
 *   404 -> unknown token      -> "not a valid link"
 *   410 -> expired / revoked / used up  -> the API's own wording, which already
 *          says which of the three it was
 *   403 -> shouldn't happen   -> generic, with a retry
 */

const ROLE_LABEL: Record<Role, string> = {
  OWNER: "the owner",
  EDITOR: "an Editor",
  VIEWER: "a Viewer",
};

/** "You're already an Editor" / "...the owner" — reads as a sentence. */
function article(role: Role): string {
  return ROLE_LABEL[role];
}

/** Bare role name, for "changed from Viewer to Editor". */
function label(role: Role): string {
  return role === "OWNER" ? "Owner" : role === "EDITOR" ? "Editor" : "Viewer";
}

type State =
  | { kind: "working" }
  | { kind: "failed"; title: string; detail: string; canRetry: boolean };

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { user, loading } = useAuth();
  const { show } = useToast();
  const [state, setState] = useState<State>({ kind: "working" });

  /**
   * Redemption SPENDS A USE, so it must happen exactly once. React 18+ runs
   * effects twice in development StrictMode, which would burn two uses of a
   * multi-use invite (and make a single-use invite fail on its own second call).
   */
  const attempted = useRef(false);

  const accept = useCallback(async () => {
    setState({ kind: "working" });
    try {
      const room = await api.acceptInvite(token);

      // SAY WHAT ACTUALLY HAPPENED. An invite that changed nothing used to be
      // indistinguishable from one that granted access: same redirect, same
      // board, no signal. A view-only link redeemed by an existing editor is the
      // case that actually bit — it silently granted nothing.
      //
      // The toast is raised BEFORE navigating: ToastProvider lives in the root
      // layout, so it survives a client-side route change and the message is
      // read on the board rather than on a page that is about to disappear.
      if (room.outcome === "alreadyMember") {
        show(`You're already ${article(room.role)} on this board.`, {
          tone: "info",
          key: "invite-outcome",
        });
      } else if (room.outcome === "upgraded" && room.previousRole) {
        show(
          `Your access changed from ${label(room.previousRole)} to ${label(room.role)}.`,
          { tone: "info", key: "invite-outcome" },
        );
      }

      // replace(), not push(): the invite URL is spent, so leaving it in history
      // means Back re-runs a redemption that can only fail.
      router.replace(`/room/${room.slug}`);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setState({
          kind: "failed",
          title: "Something went wrong",
          detail: "Couldn't use this invite link.",
          canRetry: true,
        });
        return;
      }
      if (err.status === 404) {
        setState({
          kind: "failed",
          title: "This invite link isn't valid",
          detail: "Check you copied the whole link, or ask for a new one.",
          canRetry: false,
        });
      } else if (err.status === 410) {
        // The API distinguishes expired / revoked / used up in its message, so
        // it is shown verbatim rather than flattened into one phrase.
        setState({
          kind: "failed",
          title: "This invite can't be used",
          detail: `${err.message} Ask the board's owner for a new link.`,
          canRetry: false,
        });
      } else {
        setState({
          kind: "failed",
          title: "Couldn't join this board",
          detail: err.message,
          canRetry: true,
        });
      }
    }
  }, [token, router, show]);

  useEffect(() => {
    // Wait for AuthProvider to settle: acting while `loading` would send a
    // signed-in user to the sign-in page on a slow /auth/me.
    if (loading) return;

    if (!user) {
      // Route through sign-in and come straight back here, the same `?next=`
      // contract the rest of the app uses. The token stays in the URL, so the
      // redemption happens after signing in rather than being lost.
      router.replace(`/signin?next=${encodeURIComponent(`/invite/${token}`)}`);
      return;
    }

    if (attempted.current) return;
    attempted.current = true;
    void accept();
  }, [loading, user, router, token, accept]);

  if (state.kind === "working") {
    return (
      <FullScreen>
        <Spinner />
        <p className="text-sm text-slate-500">Joining board…</p>
      </FullScreen>
    );
  }

  return (
    <FullScreen>
      <div
        data-testid="invite-failed"
        className="flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-white p-6 shadow-md ring-1 ring-slate-900/5"
      >
        <Lock className="h-6 w-6 text-slate-400" strokeWidth={2} />
        <h1 className="text-lg font-semibold text-slate-900">{state.title}</h1>
        <p className="text-sm text-slate-500">{state.detail}</p>
        <div className="flex gap-3">
          {state.canRetry && (
            <Button
              onClick={() => {
                attempted.current = true;
                void accept();
              }}
            >
              Try again
            </Button>
          )}
          <Link href="/rooms">
            <Button variant={state.canRetry ? "secondary" : "primary"}>
              Back to boards
            </Button>
          </Link>
        </div>
      </div>
    </FullScreen>
  );
}

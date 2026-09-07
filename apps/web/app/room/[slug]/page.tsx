"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { api, ApiError, type RoomDetail } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/AuthProvider";
import { Protected } from "@/lib/auth/Protected";
import { Button, FullScreen, Spinner } from "@/components/ui";
import { CanvasStage } from "@/app/canvas/CanvasStage";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; room: RoomDetail }
  /** 403 on a LINK board — you may join by asking. */
  | { kind: "join" }
  /** 403 on a PRIVATE board — you may not. Needs an invite. */
  | { kind: "noaccess" }
  | { kind: "notfound" }
  | { kind: "error"; message: string };

function Board({ slug }: { slug: string }) {
  const { user } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [joining, setJoining] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const room = await api.getRoom(slug);
      setState({ kind: "ready", room });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          // EVERY 403 used to render as "Join this board?", which became wrong
          // the moment private boards existed — it offered a button that could
          // only ever fail. The 403 body now carries the room's visibility, so
          // the two cases are distinguishable.
          //
          // Unknown/absent visibility is treated as PRIVATE: refusing to offer a
          // join is the safe direction, and an older API that does not send the
          // field would otherwise fall back to the exact bug being fixed.
          setState({ kind: err.visibility === "LINK" ? "join" : "noaccess" });
        } else if (err.status === 404) setState({ kind: "notfound" });
        else setState({ kind: "error", message: err.message });
      } else {
        setState({ kind: "error", message: "Couldn't load this board." });
      }
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function join() {
    setJoining(true);
    try {
      await api.joinRoom(slug);
      await load(); // now a member -> re-fetch metadata and render the board
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof ApiError ? err.message : "Couldn't join this board.",
      });
    } finally {
      setJoining(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <FullScreen>
        <Spinner />
      </FullScreen>
    );
  }

  if (state.kind === "join") {
    return (
      <FullScreen>
        <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-white p-6 shadow-md ring-1 ring-slate-900/5">
          <h1 className="text-lg font-semibold text-slate-900">Join this board?</h1>
          <p className="text-sm text-slate-500">
            You&apos;ve been invited to collaborate. Join as an editor to start
            drawing together.
          </p>
          <div className="flex gap-3">
            <Button onClick={join} disabled={joining}>
              {joining ? "Joining…" : "Join board"}
            </Button>
            <Link href="/rooms">
              <Button variant="secondary">Cancel</Button>
            </Link>
          </div>
        </div>
      </FullScreen>
    );
  }

  if (state.kind === "noaccess") {
    return (
      <FullScreen>
        <div
          data-testid="no-access"
          className="flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-white p-6 shadow-md ring-1 ring-slate-900/5"
        >
          <Lock className="h-6 w-6 text-slate-400" strokeWidth={2} />
          <h1 className="text-lg font-semibold text-slate-900">
            You don&apos;t have access to this board
          </h1>
          <p className="text-sm text-slate-500">
            This board is private. Ask its owner for an invite link — a board
            link on its own won&apos;t let you in.
          </p>
          {/* Deliberately NO join button: on a private board it could only ever
              produce a 403, and an affordance that cannot work is worse than
              none. */}
          <Link href="/rooms">
            <Button>Back to boards</Button>
          </Link>
        </div>
      </FullScreen>
    );
  }

  if (state.kind === "notfound") {
    return (
      <FullScreen>
        <div className="flex max-w-sm flex-col items-center gap-4">
          <h1 className="text-lg font-semibold text-slate-900">Board not found</h1>
          <p className="text-sm text-slate-500">
            This board doesn&apos;t exist or the link is wrong.
          </p>
          <Link href="/rooms">
            <Button>Back to boards</Button>
          </Link>
        </div>
      </FullScreen>
    );
  }

  if (state.kind === "error") {
    return (
      <FullScreen>
        <div className="flex max-w-sm flex-col items-center gap-4">
          <h1 className="text-lg font-semibold text-slate-900">
            Something went wrong
          </h1>
          <p className="text-sm text-slate-500">{state.message}</p>
          <Button onClick={load}>Try again</Button>
        </div>
      </FullScreen>
    );
  }

  // ready — the socket only mounts now, once membership is confirmed. `user` is
  // always present here (Board renders inside <Protected>).
  if (!user) return null;
  return (
    <CanvasStage
      roomId={state.room.id}
      roomName={state.room.name}
      slug={state.room.slug}
      user={user}
      role={state.room.role}
    />
  );
}

export default function RoomPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  return (
    <Protected>
      <Board slug={slug} />
    </Protected>
  );
}

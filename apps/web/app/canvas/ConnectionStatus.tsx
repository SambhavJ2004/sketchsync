"use client";

import { useEffect, useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";
import type { RealtimeStatus } from "@/lib/realtime/socket";

/**
 * Persistent, inline connection indicator.
 *
 * 4.4b built four socket statuses and nothing outside the test hook consumed
 * them, so a user whose socket dropped saw an entirely normal canvas and kept
 * drawing. Mutations made while disconnected are DROPPED, not replayed (a
 * documented deferral, pinned by an e2e test) — which turns silence here into
 * data loss the user only discovers on reload.
 *
 * Deliberately not a modal or a blocking overlay: the state is recoverable,
 * usually lasts under a second, and the canvas stays usable throughout. It is a
 * calm pill that states the consequence rather than an alarm.
 */

/**
 * Nothing is shown until the socket has been down this long.
 *
 * Measured connect time is ~283 ms (134 ms ticket + 103 ms handshake) and the
 * reconnect backoff starts at 500 ms, so without a grace window every ordinary
 * page load and every momentary blip would flash a warning. Long enough to hide
 * the normal case, short enough that a genuine outage is visible immediately.
 */
const GRACE_MS = 400;

interface Props {
  status: RealtimeStatus;
  /** False until the socket has opened at least once (changes the wording). */
  hasConnected: boolean;
}

export function ConnectionStatus({ status, hasConnected }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (status === "open") {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [status]);

  if (status === "open" || !visible) return null;

  // signedOut is terminal and the board is already navigating to /signin; say
  // something true for the frame or two before that lands.
  const signedOut = status === "signedOut";
  const title = signedOut
    ? "Session expired"
    : hasConnected
      ? "Reconnecting…"
      : "Connecting to the board…";
  const detail = signedOut
    ? "Taking you to sign in."
    : "Changes you make now will not be saved.";

  return (
    <div
      data-testid="connection-status"
      data-status={status}
      role="status"
      className="pointer-events-none absolute bottom-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow-sm ring-1 ring-amber-300/70 backdrop-blur"
    >
      {signedOut ? (
        <CloudOff className="h-4 w-4 shrink-0" strokeWidth={2} />
      ) : (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={2} />
      )}
      <span className="font-medium">{title}</span>
      <span className="text-amber-800/80">{detail}</span>
    </div>
  );
}

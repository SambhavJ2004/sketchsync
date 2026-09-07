import {
  INTERNAL_SECRET_HEADER,
  type EvictRequest,
} from "@sketchsync/shared";
import { env } from "../env.js";

/**
 * Tell the realtime gateway that a member's access changed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONE PLACE apps/api TALKS TO apps/realtime.
 *
 * Before this, the two services shared a database and nothing else — no network
 * call, no direction of dependency, either could restart without the other
 * noticing. That property is given up here deliberately, because removing or
 * demoting a member had no effect on an established socket: `conn.role` is
 * snapshotted at `join`, so the user kept drawing until they reconnected.
 *
 * The coupling is contained by making the call NON-LOAD-BEARING:
 *
 *   - Nothing branches on the result. The caller does not await a decision.
 *   - Short timeout. A sleeping gateway (Render's free tier sleeps after ~15
 *     minutes) must not add its cold-start to an owner's click.
 *   - EVERY failure is logged and swallowed. A member removal that succeeded in
 *     the database must never report failure because a side-channel notification
 *     did not land.
 *   - No secret configured => no call at all, silently. Local development runs
 *     without eviction and is a correct system, just a slower-reacting one.
 *
 * THE ACTUAL GUARANTEE IS ELSEWHERE. `handleJoin` on the gateway re-reads
 * membership from the database on every join, so a removed user cannot
 * reconnect. This only shortens the window between "removed in the database" and
 * "their current socket notices". Treating it as the enforcement point would be
 * a real security bug: it fails open by design.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Long enough for a warm service on the same network, short enough that a cold
 *  or unreachable one does not stall the request the user is waiting on. */
const EVICT_TIMEOUT_MS = 2000;

export function notifyEviction(request: EvictRequest): void {
  // Fire-and-forget: deliberately NOT returned or awaited by the routes. The
  // floating promise is the point, so `void` marks it as intentional rather
  // than a forgotten await.
  void sendEviction(request);
}

/** Exported for tests: same behaviour, but awaitable so a test can observe that
 *  an unreachable gateway resolves rather than throwing. */
export async function sendEviction(request: EvictRequest): Promise<boolean> {
  const secret = env.INTERNAL_SECRET;
  if (!secret) {
    // Eviction disabled (normal locally). Not an error, and not worth a log line
    // on every membership change.
    return false;
  }

  try {
    const res = await fetch(`${env.REALTIME_INTERNAL_URL}/internal/evict`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_SECRET_HEADER]: secret,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(EVICT_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Logged, never thrown. A 403 here means the two services disagree about
      // the secret — worth seeing in logs, not worth failing a removal over.
      console.warn(
        `evict notify: gateway returned ${res.status} for ` +
          `${request.action} room=${request.roomId} user=${request.userId}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    // Timeout, DNS failure, connection refused, service asleep. All expected
    // and all survivable.
    console.warn(
      `evict notify failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

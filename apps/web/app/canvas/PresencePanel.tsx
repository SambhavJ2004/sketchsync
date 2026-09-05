"use client";

import type { PresenceUser } from "@sketchsync/shared";
import { userColor, userInitials } from "@/lib/realtime/userColor";

interface Props {
  users: PresenceUser[];
  myUserId: string | null;
}

export function PresencePanel({ users, myUserId }: Props) {
  // Solo (just you) or empty -> no chrome.
  if (users.length < 2) return null;

  // Put "you" first for a stable, predictable order.
  const ordered = [...users].sort((a, b) =>
    a.userId === myUserId ? -1 : b.userId === myUserId ? 1 : 0,
  );

  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {ordered.map((u) => {
          const isYou = u.userId === myUserId;
          return (
            <div
              key={u.userId}
              title={isYou ? `${u.name} (you)` : u.name}
              className={`flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ${
                isYou ? "ring-slate-900/70" : "ring-white"
              }`}
              style={{ background: userColor(u.userId) }}
            >
              {userInitials(u.name)}
            </div>
          );
        })}
      </div>
      <span className="rounded-md bg-white/80 px-2 py-1 text-xs text-slate-500 shadow-sm ring-1 ring-slate-900/5">
        {users.length} here
      </span>
    </div>
  );
}

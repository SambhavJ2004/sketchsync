"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { api } from "@/lib/api/client";
import { useAuth } from "./AuthProvider";

/**
 * Signs out (POST /auth/signout, clears the cookie), drops local auth state, and
 * redirects to /signin. `compact` renders an icon-only button for the board chrome.
 */
export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { setUser } = useAuth();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await api.signout();
    } catch {
      // Even if the request fails, drop local state and leave the app.
    }
    setUser(null);
    router.replace("/signin");
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        title="Sign out"
        aria-label="Sign out"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
      >
        <LogOut className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-900/10 transition hover:bg-slate-100 disabled:opacity-50"
    >
      <LogOut className="h-4 w-4" strokeWidth={2} />
      Sign out
    </button>
  );
}

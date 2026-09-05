"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { Button, FullScreen, Spinner } from "@/components/ui";

/**
 * Gates its children behind authentication. While `/auth/me` is resolving it
 * shows a spinner (so pages never flash the wrong content); once resolved, an
 * unauthenticated user is sent to /signin?next=<path they wanted> so a shared
 * board link survives a sign-in detour.
 */
export function Protected({ children }: { children: ReactNode }) {
  const { user, loading, error, refresh } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Redirect ONLY when the server positively said there is no session. An
  // unreachable server is not a sign-out, so it must not bounce the user to
  // /signin — where they'd try to log in against the same dead API.
  useEffect(() => {
    if (!loading && !user && !error) {
      const next = encodeURIComponent(pathname);
      router.replace(`/signin?next=${next}`);
    }
  }, [loading, user, error, pathname, router]);

  if (loading) {
    return (
      <FullScreen>
        <Spinner />
      </FullScreen>
    );
  }

  if (!user && error) {
    return (
      <FullScreen>
        <div className="flex max-w-sm flex-col items-center gap-4">
          <h1 className="text-lg font-semibold text-slate-900">
            Can&apos;t reach SketchSync
          </h1>
          <p className="text-sm text-slate-500">{error}</p>
          <p className="text-xs text-slate-400">
            You have not been signed out — this is a connection problem.
          </p>
          <Button onClick={() => void refresh()}>Try again</Button>
        </div>
      </FullScreen>
    );
  }

  if (!user) {
    return (
      <FullScreen>
        <Spinner />
      </FullScreen>
    );
  }
  return <>{children}</>;
}

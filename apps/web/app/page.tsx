"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import { Button, FullScreen, Spinner } from "@/components/ui";

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace("/rooms");
  }, [loading, user, router]);

  if (loading || user) {
    return (
      <FullScreen>
        <Spinner />
      </FullScreen>
    );
  }

  return (
    <FullScreen>
      <div className="flex max-w-md flex-col items-center gap-6">
        <div className="flex flex-col gap-3">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
            SketchSync
          </h1>
          <p className="text-lg text-slate-500">
            Real-time collaborative infinite whiteboard. Draw together, live.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/signin">
            <Button>Sign in</Button>
          </Link>
          <Link href="/signup">
            <Button variant="secondary">Sign up</Button>
          </Link>
        </div>
      </div>
    </FullScreen>
  );
}

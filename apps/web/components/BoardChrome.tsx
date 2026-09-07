"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Link2 } from "lucide-react";
import { SignOutButton } from "@/lib/auth/SignOutButton";
import type { Role } from "@/lib/api/client";
import { ExportMenu } from "./ExportMenu";
import { SharePanel } from "./SharePanel";

/**
 * Unobtrusive top-right board chrome: back-to-boards, board name, a "Copy link"
 * button (copies the /room/[slug] URL), and sign-out. The canvas is the point,
 * so this stays a compact pill.
 */
export function BoardChrome({
  name,
  slug,
  role,
}: {
  name: string;
  slug: string;
  role: Role;
}) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    const url = `${window.location.origin}/room/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard blocked (e.g. insecure context / permissions) — no-op.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center gap-1 rounded-xl bg-white/90 p-1 pl-2 shadow-md ring-1 ring-slate-900/10 backdrop-blur">
      <Link
        href="/rooms"
        title="All boards"
        aria-label="All boards"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100"
      >
        <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
      </Link>
      <span className="max-w-[12rem] truncate px-1 text-sm font-medium text-slate-900">
        {name}
      </span>
      <button
        type="button"
        onClick={copyLink}
        title="Copy board link"
        aria-label="Copy board link"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100"
      >
        {copied ? (
          <Check className="h-[18px] w-[18px] text-green-600" strokeWidth={2.5} />
        ) : (
          <Link2 className="h-[18px] w-[18px]" strokeWidth={2} />
        )}
      </button>
      <SharePanel slug={slug} role={role} />
      <ExportMenu boardName={name} />
      <SignOutButton compact />
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

/**
 * Human-readable shortcut labels that do not lie about the user's keyboard.
 *
 * Two separate problems, both of which the hardcoded "⌘]" strings got wrong:
 *
 * 1. MODIFIER. The handler accepts metaKey OR ctrlKey on every platform, but the
 *    label said ⌘ unconditionally — wrong for every Windows and Linux user.
 *
 * 2. LAYOUT. Layer ordering is keyed on `e.code` ("BracketRight"), which is
 *    deliberately POSITIONAL — that is what makes Shift-to-front work without
 *    caring that Shift turns "]" into "}". The consequence is that on a
 *    non-US layout the key at that position prints something else entirely
 *    (German QWERTZ: "+", French AZERTY: "$"), so the label was wrong there too.
 *
 *    CHOSEN: keep `e.code` (positional is correct — the shortcut should stay
 *    under the same finger regardless of layout) and resolve the label with
 *    `navigator.keyboard.getLayoutMap()`, which reports the character that
 *    physical key actually produces. Where the API is unavailable (Firefox,
 *    Safari) we fall back to "]"/"[", i.e. exactly today's behaviour — no
 *    regression, and correct on every browser that can tell us the truth.
 *    The alternative — rebinding to `e.key` so the label is trivially right —
 *    was rejected: it would move the shortcut to a different physical key per
 *    layout and reintroduce the Shift problem the `e.code` choice solved.
 */

/** "⌘" on Apple platforms, "Ctrl" everywhere else. */
export function modLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "⌘" : "Ctrl";
}

/** Joins a modifier to a key without a stray separator after "⌘". */
export function withModLabel(mod: string, rest: string): string {
  return mod === "⌘" ? `⌘${rest}` : `${mod}+${rest}`;
}

export interface BracketLabels {
  left: string;
  right: string;
}

export const DEFAULT_BRACKETS: BracketLabels = { left: "[", right: "]" };

interface KeyboardLayoutCapable {
  keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> };
}

/**
 * Resolve what the BracketLeft/BracketRight physical keys print on this
 * keyboard. Returns the US defaults if the browser cannot say.
 */
export async function bracketLabels(): Promise<BracketLabels> {
  if (typeof navigator === "undefined") return DEFAULT_BRACKETS;
  const getLayoutMap = (navigator as Navigator & KeyboardLayoutCapable).keyboard
    ?.getLayoutMap;
  if (!getLayoutMap) return DEFAULT_BRACKETS;
  try {
    const map = await getLayoutMap.call(
      (navigator as Navigator & KeyboardLayoutCapable).keyboard,
    );
    return {
      left: map.get("BracketLeft") ?? DEFAULT_BRACKETS.left,
      right: map.get("BracketRight") ?? DEFAULT_BRACKETS.right,
    };
  } catch {
    return DEFAULT_BRACKETS;
  }
}

export interface ShortcutLabels {
  /** "⌘" or "Ctrl". */
  mod: string;
  brackets: BracketLabels;
  /** `key("Z")` -> "⌘Z" or "Ctrl+Z". */
  key: (rest: string) => string;
}

/**
 * Resolve labels AFTER mount.
 *
 * Both inputs (userAgent, keyboard layout) exist only in the browser, so
 * computing them during render would make the server HTML disagree with the
 * client's first paint — a hydration mismatch for a tooltip. Starting from the
 * US/Ctrl defaults means the server and the first client render always match,
 * and the correction lands a tick later.
 */
export function useShortcutLabels(): ShortcutLabels {
  const [mod, setMod] = useState("Ctrl");
  const [brackets, setBrackets] = useState<BracketLabels>(DEFAULT_BRACKETS);

  useEffect(() => {
    let live = true;
    setMod(modLabel());
    void bracketLabels().then((b) => {
      if (live) setBrackets(b);
    });
    return () => {
      live = false;
    };
  }, []);

  return { mod, brackets, key: (rest: string) => withModLabel(mod, rest) };
}

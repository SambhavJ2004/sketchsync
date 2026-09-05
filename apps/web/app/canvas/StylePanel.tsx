"use client";

import { useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
} from "lucide-react";
import { useCanvasStore } from "@/lib/canvas/store";
import type { LayerAction } from "@/lib/canvas/layers";
import { useShortcutLabels } from "@/lib/shortcutLabel";

/**
 * `side` selects which bracket key the label should name; the actual binding is
 * positional (`e.code`), so the printed character is resolved at runtime from
 * the keyboard layout — see lib/shortcutLabel.ts. These strings used to be
 * hardcoded "⌘]" and were wrong twice over: ⌘ on Windows, and "]" on any layout
 * where that physical key prints something else.
 */
const LAYER_BUTTONS: {
  action: LayerAction;
  label: string;
  side: "left" | "right";
  shift: boolean;
  Icon: typeof ChevronUp;
}[] = [
  { action: "front", label: "Bring to front", side: "right", shift: true, Icon: ChevronsUp },
  { action: "forward", label: "Bring forward", side: "right", shift: false, Icon: ChevronUp },
  { action: "backward", label: "Send backward", side: "left", shift: false, Icon: ChevronDown },
  { action: "back", label: "Send to back", side: "left", shift: true, Icon: ChevronsDown },
];

const SWATCHES = [
  "#111827",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
];
const WIDTHS = [1, 2, 4, 8];
const DEFAULT_FILL = "#dbeafe";

/**
 * Idle window before a colour drag becomes one undo entry.
 *
 * CHOSEN: debounce-on-idle, with an immediate flush on blur/close.
 *
 * Commit-on-close alone (the native `change` event) is more deterministic in
 * principle, but React's onChange maps to the DOM `input` event, and browsers
 * disagree about when `change` fires for `<input type="color">` — Safari fires
 * it during the drag too. Relying on it would give per-browser history
 * behaviour. Idle-debounce behaves identically everywhere and is directly
 * testable ("N rapid changes then quiet -> exactly 1 entry"); the blur flush
 * removes the only real drawback, which is a commit arriving later than the
 * user's attention has moved on.
 */
const COLOR_COMMIT_IDLE_MS = 350;

export function StylePanel() {
  const defaults = useCanvasStore((s) => s.style);
  const scene = useCanvasStore((s) => s.scene);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const apply = useCanvasStore((s) => s.applyStyleToSelection);
  const preview = useCanvasStore((s) => s.previewStyleOnSelection);
  const commit = useCanvasStore((s) => s.commitStylePreview);
  const layerAction = useCanvasStore((s) => s.layerAction);
  const labels = useShortcutLabels();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    commit();
  };
  /** Live preview now; one history entry once the drag goes quiet. */
  const previewColor = (patch: Partial<typeof defaults>): void => {
    preview(patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, COLOR_COMMIT_IDLE_MS);
  };
  // A pending commit must not be lost if the panel unmounts mid-drag.
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      useCanvasStore.getState().commitStylePreview();
    }
  }, []);

  const firstId = selectedIds[0];
  const selected = firstId ? scene.find((e) => e.id === firstId) : undefined;
  const hasSelection = selected !== undefined;
  const singleSelected = selectedIds.length === 1 && hasSelection;
  // Show the selected element's style, or the new-shape defaults.
  const style = selected ? selected.data.style : defaults;
  const fillOn = style.fill !== undefined;

  return (
    <div className="absolute left-3 top-3 z-40 flex w-44 flex-col gap-3 rounded-xl bg-white/90 p-3 text-xs shadow-md ring-1 ring-slate-900/10 backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-slate-700">
          {hasSelection ? "Selected" : "New shape"}
        </span>
        {hasSelection && selectedIds.length > 1 && (
          <span className="text-slate-400">×{selectedIds.length}</span>
        )}
      </div>

      <section>
        <div className="mb-1.5 font-medium text-slate-500">Stroke</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`stroke ${c}`}
              onClick={() => apply({ stroke: c })}
              className={`h-6 w-6 rounded-full ring-1 ring-slate-900/10 ${
                style.stroke === c
                  ? "outline outline-2 outline-offset-1 outline-slate-900"
                  : ""
              }`}
              style={{ background: c }}
            />
          ))}
          <input
            type="color"
            aria-label="custom stroke color"
            value={style.stroke}
            data-testid="stroke-color"
            onChange={(e) => previewColor({ stroke: e.target.value })}
            onBlur={flush}
            className="h-6 w-6 cursor-pointer rounded bg-transparent p-0"
          />
        </div>
      </section>

      <section>
        <div className="mb-1.5 font-medium text-slate-500">Width</div>
        <div className="flex items-center gap-1.5">
          {WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              title={`${w}px`}
              aria-label={`width ${w}`}
              onClick={() => apply({ width: w })}
              className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                style.width === w
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <span
                className="rounded-full bg-current"
                style={{ width: w + 2, height: w + 2 }}
              />
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-1.5 font-medium text-slate-500">Fill</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={fillOn}
            onClick={() => apply({ fill: fillOn ? undefined : DEFAULT_FILL })}
            className={`rounded-lg px-2.5 py-1 ${
              fillOn
                ? "bg-slate-900 text-white"
                : "text-slate-600 ring-1 ring-slate-900/10 hover:bg-slate-100"
            }`}
          >
            {fillOn ? "On" : "Off"}
          </button>
          {fillOn && (
            <input
              type="color"
              aria-label="fill color"
              value={style.fill}
              data-testid="fill-color"
              onChange={(e) => previewColor({ fill: e.target.value })}
              onBlur={flush}
              className="h-6 w-6 cursor-pointer rounded bg-transparent p-0"
            />
          )}
        </div>
      </section>

      {singleSelected && (
        <section>
          <div className="mb-1.5 font-medium text-slate-500">Layer</div>
          <div className="flex items-center gap-1.5">
            {LAYER_BUTTONS.map(({ action, label, side, shift, Icon }) => {
              const bracket = labels.brackets[side];
              const shortcut = labels.key(`${shift ? "⇧" : ""}${bracket}`);
              return (
              <button
                key={action}
                type="button"
                title={`${label} (${shortcut})`}
                aria-label={label}
                onClick={() => layerAction(action)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
              </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

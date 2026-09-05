"use client";

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas/store";
import { measureTextWidth } from "@/lib/canvas/textMeasure";
import { sceneToSvg } from "@/lib/canvas/exportSvg";
import { ExportTooLargeError, sceneToPng } from "@/lib/canvas/exportPng";

type Format = "png" | "svg";
type Scope = "board" | "selection";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function safeName(name: string): string {
  return name.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "board";
}

export function ExportMenu({ boardName }: { boardName: string }) {
  const scene = useCanvasStore((s) => s.scene);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>("png");
  const [scale, setScale] = useState(2);
  const [scope, setScope] = useState<Scope>("board");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const hasSelection = selectedIds.length > 0;
  // Selection scope is only meaningful while something is selected.
  const effectiveScope: Scope = hasSelection ? scope : "board";
  const isEmpty = scene.length === 0;

  /**
   * KEYBOARD ISOLATION while the panel is open.
   *
   * The panel used to listen on `document` while the canvas listens on
   * `window`, so both fired for the same keystroke: Escape closed the panel AND
   * ran clearSelection() — which destroyed the very selection a
   * "Selection"-scoped export was about to use. Every other canvas shortcut
   * (r, Delete, Ctrl+Z) reached the board through the open panel too.
   *
   * CHOSEN: capture-phase listener on `window` that stops propagation for every
   * key, rather than making the panel a true modal. It is a popover anchored to
   * its trigger; a real modal would need a focus trap, a backdrop and
   * aria-modal, and would block the canvas underneath — more machinery than the
   * problem needs. Capture at `window` is strictly ordered BEFORE any
   * bubble-phase listener (canvas included) and does not depend on React's event
   * delegation, so it cannot be broken by a React internals change.
   *
   * stopPropagation does not suppress DEFAULT actions, so Tab still moves focus
   * and Enter/Space still activate the focused button inside the panel.
   */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Move focus into the panel on open, and back to the trigger on close — so a
  // keyboard user is not dropped at the top of the document either way.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) panelRef.current?.focus();
    else if (wasOpen.current) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  async function run(): Promise<void> {
    setError("");
    setBusy(true);
    try {
      const sel = new Set(selectedIds);
      const subject =
        effectiveScope === "selection" ? scene.filter((e) => sel.has(e.id)) : scene;
      const base = `${safeName(boardName)}${effectiveScope === "selection" ? "-selection" : ""}`;

      if (format === "svg") {
        const out = sceneToSvg(subject, measureTextWidth);
        if (!out) {
          setError("Nothing to export.");
          return;
        }
        download(new Blob([out.svg], { type: "image/svg+xml" }), `${base}.svg`);
      } else {
        const out = await sceneToPng(subject, measureTextWidth, { scale });
        if (!out) {
          setError("Nothing to export.");
          return;
        }
        download(out.blob, `${base}@${scale}x.png`);
      }
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof ExportTooLargeError
          ? err.message
          : "Export failed. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const btn = (active: boolean): string =>
    `rounded-md px-2 py-1 text-xs font-medium transition ${
      active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
    }`;

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Export"
        aria-label="Export"
        aria-expanded={open}
        data-testid="export-trigger"
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100"
      >
        <Download className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>

      {open && (
        <div
          ref={panelRef}
          tabIndex={-1}
          data-testid="export-panel"
          className="absolute right-0 top-10 z-50 flex w-60 flex-col gap-3 rounded-xl bg-white p-3 text-xs shadow-lg outline-none ring-1 ring-slate-900/10"
        >
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-slate-500">Format</span>
            <div className="flex gap-1">
              <button type="button" data-testid="format-png" className={btn(format === "png")} onClick={() => setFormat("png")}>
                PNG
              </button>
              <button type="button" data-testid="format-svg" className={btn(format === "svg")} onClick={() => setFormat("svg")}>
                SVG
              </button>
            </div>
          </div>

          {format === "png" && (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-slate-500">Scale</span>
              <div className="flex gap-1">
                <button type="button" data-testid="scale-1" className={btn(scale === 1)} onClick={() => setScale(1)}>
                  1×
                </button>
                <button type="button" data-testid="scale-2" className={btn(scale === 2)} onClick={() => setScale(2)}>
                  2× (retina)
                </button>
              </div>
            </div>
          )}

          {hasSelection && (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-slate-500">Scope</span>
              <div className="flex gap-1">
                <button type="button" data-testid="scope-board" className={btn(scope === "board")} onClick={() => setScope("board")}>
                  Whole board
                </button>
                <button type="button" data-testid="scope-selection" className={btn(scope === "selection")} onClick={() => setScope("selection")}>
                  Selection ({selectedIds.length})
                </button>
              </div>
            </div>
          )}

          {/* Stated where the choice is made, not hidden in a tooltip. */}
          {format === "svg" && (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-800">
              Text stays editable and uses the system font stack, so it may
              re-flow on a machine with different fonts. Export PNG for an
              exact visual copy.
            </p>
          )}

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-2 py-1.5 text-[11px] leading-snug text-red-600">
              {error}
            </p>
          )}

          {/* The run button is disabled on an empty board. Say why — a control
              that is greyed out for no stated reason reads as broken. */}
          {isEmpty && (
            <p
              data-testid="export-empty-reason"
              className="rounded-md bg-slate-50 px-2 py-1.5 text-[11px] leading-snug text-slate-500"
            >
              This board is empty — draw something to export it.
            </p>
          )}

          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || isEmpty}
            data-testid="export-run"
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Exporting…" : `Export ${format.toUpperCase()}`}
          </button>
        </div>
      )}
    </div>
  );
}

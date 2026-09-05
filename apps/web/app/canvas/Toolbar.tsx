"use client";

import type { ComponentType } from "react";
import {
  ArrowUpRight,
  Circle,
  Hand,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Type,
} from "lucide-react";
import { useCanvasStore, type Tool } from "@/lib/canvas/store";

interface ToolDef {
  tool: Tool;
  label: string;
  shortcut: string;
  Icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}

const TOOLS: ToolDef[] = [
  { tool: "select", label: "Select", shortcut: "V", Icon: MousePointer2 },
  { tool: "rect", label: "Rectangle", shortcut: "R", Icon: Square },
  { tool: "ellipse", label: "Ellipse", shortcut: "O", Icon: Circle },
  { tool: "line", label: "Line", shortcut: "L", Icon: Minus },
  { tool: "arrow", label: "Arrow", shortcut: "A", Icon: ArrowUpRight },
  { tool: "pencil", label: "Pencil", shortcut: "P", Icon: Pencil },
  { tool: "text", label: "Text", shortcut: "T", Icon: Type },
  { tool: "pan", label: "Pan", shortcut: "H / Space", Icon: Hand },
];

/** Tools a read-only client may still use: inspect and navigate. */
const READ_ONLY_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["select", "pan"]);

export function Toolbar({ canEdit = true }: { canEdit?: boolean }) {
  const tool = useCanvasStore((s) => s.tool);
  const setTool = useCanvasStore((s) => s.setTool);

  return (
    <div className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl bg-white/90 p-1 shadow-md ring-1 ring-slate-900/10 backdrop-blur">
      {TOOLS.map(({ tool: t, label, shortcut, Icon }) => {
        const active = tool === t;
        // Disabled rather than hidden: a VIEWER should be able to see that the
        // drawing tools exist and are withheld, not wonder where they went.
        const disabled = !canEdit && !READ_ONLY_TOOLS.has(t);
        const title = disabled
          ? `${label} — you have view-only access to this board`
          : `${label} (${shortcut})`;
        return (
          <button
            key={t}
            type="button"
            onClick={() => setTool(t)}
            disabled={disabled}
            data-testid={`tool-${t}`}
            title={title}
            aria-label={title}
            aria-pressed={active}
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${
              active
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100"
            } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
          >
            <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}

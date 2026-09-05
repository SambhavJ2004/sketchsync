"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Minimal toast channel for errors that arrive UNSOLICITED.
 *
 * Every other error surface in the app is attached to something the user just
 * did — a submitted form, a clicked export. The socket produces the opposite
 * category: a dropped mutation, a rejected write, a server `error` frame. Those
 * have no form to render into, and until now they went to `console.warn` and
 * nowhere else, which in a production build is nowhere at all.
 *
 * `role="alert"` (assertive live region) rather than `aria-live="polite"`: these
 * announce that something the user did was NOT saved, which should interrupt.
 */

export type ToastTone = "error" | "info";

export interface ToastOptions {
  tone?: ToastTone;
  /** ms before auto-dismiss. */
  durationMs?: number;
  /**
   * Dedupe key. A second toast with the same key REPLACES the first and
   * restarts its timer instead of stacking. The socket is bursty — a flood of
   * dropped mutations is one condition, not N notifications.
   */
  key?: string;
}

interface ToastItem {
  id: number;
  key: string;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  /** Show a toast. Stable identity — safe in an effect dependency list. */
  show: (message: string, options?: ToastOptions) => void;
  dismiss: (key: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextId = useRef(1);

  const dismiss = useCallback((key: string) => {
    const t = timers.current.get(key);
    if (t) {
      clearTimeout(t);
      timers.current.delete(key);
    }
    setToasts((list) => list.filter((x) => x.key !== key));
  }, []);

  const show = useCallback(
    (message: string, options?: ToastOptions) => {
      const key = options?.key ?? `toast-${nextId.current++}`;
      const tone = options?.tone ?? "error";
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);

      setToasts((list) => {
        const rest = list.filter((x) => x.key !== key);
        return [...rest, { id: nextId.current++, key, message, tone }];
      });

      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setToasts((list) => list.filter((x) => x.key !== key));
        }, options?.durationMs ?? DEFAULT_DURATION_MS),
      );
    },
    [],
  );

  // Leaving timers armed after unmount would setState on a dead tree.
  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    },
    [timers],
  );

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4"
        data-testid="toast-region"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="alert"
            data-testid="toast"
            data-tone={t.tone}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl px-3 py-2 text-sm shadow-lg ring-1 backdrop-blur ${
              t.tone === "error"
                ? "bg-red-50/95 text-red-700 ring-red-200"
                : "bg-white/95 text-slate-700 ring-slate-900/10"
            }`}
          >
            <span className="flex-1 leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.key)}
              aria-label="Dismiss"
              className="shrink-0 rounded px-1 text-xs opacity-60 transition hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

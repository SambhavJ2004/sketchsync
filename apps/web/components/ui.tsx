"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Full-viewport centered container for loaders / status screens. */
export function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 p-8 text-center">
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <div
      className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900"
      role="status"
      aria-label="Loading"
    />
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
};

/** Button matching the toolbar/panel aesthetic (slate-900 primary). */
export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-slate-900 text-white hover:bg-slate-700"
      : "bg-white text-slate-700 ring-1 ring-slate-900/10 hover:bg-slate-100";
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

/** Labelled text input with an inline field error slot. */
export function Field({ label, error, id, className = "", ...props }: FieldProps) {
  return (
    <label className="flex flex-col gap-1 text-left" htmlFor={id}>
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        id={id}
        className={`rounded-lg border px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-slate-900/20 ${
          error ? "border-red-400" : "border-slate-300"
        } ${className}`}
        {...props}
      />
      {error && <span className="text-xs text-red-500">{error}</span>}
    </label>
  );
}

/**
 * Top-level (non field-specific) form error banner.
 *
 * `role="alert"` because this is how a failed sign-in is reported: without it
 * the banner appears silently and a screen-reader user gets no indication the
 * submit failed at all.
 */
export function FormError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 ring-1 ring-red-200"
    >
      {message}
    </div>
  );
}

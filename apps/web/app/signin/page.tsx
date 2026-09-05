"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { SigninInput } from "@sketchsync/shared";
import { api, ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  issuesToFieldErrors,
  safeNext,
  zodToFieldErrors,
  type FieldErrors,
} from "@/lib/forms";
import { Button, Field, FormError, FullScreen, Spinner } from "@/components/ui";

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { setUser, refresh, user, loading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const next = params.get("next");

  // Already signed in -> go straight to the destination. Gated on `loading` so
  // the form is NEVER painted first: rendering an auth form to someone who is
  // authenticated and then yanking it away is a visible flash of wrong content.
  useEffect(() => {
    if (!loading && user) router.replace(safeNext(next));
  }, [loading, user, next, router]);
  const signupHref = next ? `/signup?next=${encodeURIComponent(next)}` : "/signup";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError("");

    const parsed = SigninInput.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(zodToFieldErrors(parsed.error));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      const user = await api.signin(parsed.data);
      // Optimistic: render as signed in immediately (no round trip, no flash).
      setUser(user);
      // ...but VERIFY. Client auth state was derived from a response body, not
      // a checked session — if the cookie did not actually stick (cross-site
      // rejection, misconfigured proxy), /auth/me returns 401 and this clears
      // the user, so a broken session self-corrects within one round trip
      // instead of presenting an authenticated shell full of 401s.
      void refresh();
      router.replace(safeNext(next));
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.issues) setFieldErrors(issuesToFieldErrors(err.issues));
        setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
      setSubmitting(false);
    }
  }

  if (loading || user) return <Spinner />;

  return (
    <form
      onSubmit={onSubmit}
      className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-white p-6 shadow-md ring-1 ring-slate-900/5"
      noValidate
    >
      <div className="text-left">
        <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
        <p className="text-sm text-slate-500">Welcome back to SketchSync.</p>
      </div>

      {formError && <FormError message={formError} />}

      <Field
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors.email}
      />
      <Field
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={fieldErrors.password}
      />

      <Button type="submit" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>

      <p className="text-center text-sm text-slate-500">
        No account?{" "}
        <Link
          href={signupHref}
          className="font-medium text-slate-900 underline-offset-2 hover:underline"
        >
          Sign up
        </Link>
      </p>
    </form>
  );
}

export default function SignInPage() {
  return (
    <FullScreen>
      <Suspense fallback={<Spinner />}>
        <SignInForm />
      </Suspense>
    </FullScreen>
  );
}

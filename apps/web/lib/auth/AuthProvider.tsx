"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, type AuthUser } from "@/lib/api/client";

interface AuthContextValue {
  /** The signed-in user, or null when signed out. */
  user: AuthUser | null;
  /** True until the initial GET /auth/me resolves — gate content on this. */
  loading: boolean;
  /**
   * Set when /auth/me failed for a reason that is NOT "signed out" — the server
   * is unreachable or erroring. Distinct from `user === null`, which means the
   * server positively told us there is no session.
   */
  error: string | null;
  /** Re-fetch the current user from /auth/me. */
  refresh: () => Promise<void>;
  /** Set the user optimistically after signin/signup (avoids a round-trip). */
  setUser: (user: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Establishes the current user ONCE (GET /auth/me) and shares it app-wide.
 * Cookies are httpOnly, so auth state can only come from the server, not from
 * reading the cookie.
 *
 * ONLY a 401 clears the user. Any other failure — the API being down, a 500, a
 * DNS blip — is recorded as `error` and leaves `user` untouched. Treating those
 * as "signed out" silently logged people out on a transient network hiccup and,
 * worse, made a genuinely broken deployment look like an ordinary sign-out.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setUser(me);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null); // authoritative: there is no session
        setError(null);
      } else {
        // Unreachable or erroring — say so, and do NOT clear the session.
        setError(
          err instanceof ApiError
            ? err.message
            : "Can't reach the server. Please try again.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, error, refresh, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

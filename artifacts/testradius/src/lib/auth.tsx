import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient, type SupabaseClient, type Session, type User } from "@supabase/supabase-js";
import { useLocation, useRoute } from "wouter";
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from "./supabase-config";
import { setAuthTokenGetter } from "@workspace/api-client-react";

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signInWithGitHub: (mode?: "login" | "signup") => Promise<void>;
  signInWithGoogle: (mode?: "login" | "signup") => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Lazily create the Supabase client only when configured.
const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

// Wire the API client to attach the current Supabase JWT to every request.
if (supabase) {
  setAuthTokenGetter(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    // DEBUG: log any incoming auth token in the URL hash/fragment.
    console.log("[auth] initial URL:", window.location.href);
    console.log("[auth] URL hash present:", window.location.hash ? "yes" : "no", window.location.hash.slice(0, 40));

    // Restore existing session
    supabase.auth.getSession().then(({ data }) => {
      console.log("[auth] getSession ->", data.session ? "session found" : "no session");
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      console.log("[auth] onAuthStateChange event:", _event, "session:", newSession ? "present" : "null");
      setSession(newSession);
      setUser(newSession?.user ?? null);
      // Only run the post-OAuth provision/me + redirect flow when we are actually
      // on the OAuth return page (/login, where Google/GitHub bounced us back).
      // Token refreshes (also emitted as SIGNED_IN) must NOT navigate, or the
      // user gets yanked off whatever page they're on (e.g. Settings) when the
      // tab regains focus. We key off the pathname rather than a query param so
      // a lingering `oauth=return` in the URL can't re-trigger the redirect.
      const onLoginPage =
        typeof window !== "undefined" && window.location.pathname === "/login";
      if (_event === "SIGNED_IN" && newSession && onLoginPage) {
        const mode = (sessionStorage.getItem("auth_mode") as "login" | "signup") ?? "signup";
        sessionStorage.removeItem("auth_mode");
        console.log("[auth] SIGNED_IN mode:", mode, "user id:", newSession.user?.id);
        try {
          const token = newSession.access_token;
          console.log("[auth] token present for fetch:", !!token, "len:", token?.length);
          if (mode === "signup") {
            // Create the tenant (user row + free credits).
            const res = await authFetch("/api/auth/provision", { method: "POST" }, token);
            console.log("[auth] provision response:", res.status);
            if (!res.ok) throw new Error("provision_failed");
          } else {
            // Login mode: confirm the tenant already exists.
            const res = await authFetch("/api/auth/me", {}, token);
            console.log("[auth] me response:", res.status);
            if (res.status === 403) throw new Error("signup_required");
          }
          // Successful auth → go to the tester.
          console.log("[auth] navigating to /tester");
          navigate("/tester");
        } catch (err) {
          console.log("[auth] post-signin flow rejected:", err);
          // Backend rejected (e.g. login without prior signup). Sign out and
          // force the user back to the login screen.
          await supabase.auth.signOut();
          setSession(null);
          setUser(null);
          sessionStorage.setItem("auth_error", "signup_required");
        }
      }
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const signInWithGitHub = async (mode: "login" | "signup" = "signup") => {
    if (!supabase) throw new Error("Supabase is not configured");
    // Remember the intended flow so the post-redirect handler knows whether
    // to provision (signup) or just validate (login).
    sessionStorage.setItem("auth_mode", mode);
    const redirectTo =
      mode === "signup"
        ? `${window.location.origin}/login?mode=signup&oauth=return`
        : `${window.location.origin}/login?mode=login&oauth=return`;
    await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo },
    });
  };

  const signInWithGoogle = async (mode: "login" | "signup" = "signup") => {
    if (!supabase) throw new Error("Supabase is not configured");
    sessionStorage.setItem("auth_mode", mode);
    const redirectTo =
      mode === "signup"
        ? `${window.location.origin}/login?mode=signup&oauth=return`
        : `${window.location.origin}/login?mode=login&oauth=return`;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ session, user, loading, signInWithGitHub, signInWithGoogle, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

/**
 * Resolve the current Supabase access token for use in direct fetch calls
 * (e.g. SSE streaming) that bypass the generated API client.
 */
export async function getSessionToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * fetch() wrapper that attaches the current Supabase JWT as a Bearer token so
 * the backend's requireAuth middleware can validate the caller. Used for the
 * provision/me calls which bypass the generated API client.
 */
export async function authFetch(url: string, options: RequestInit = {}, explicitToken?: string | null): Promise<Response> {
  const token = explicitToken || (await getSessionToken());
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  console.log("[auth] authFetch ->", url, "auth header:", token ? "sent" : "MISSING");
  return fetch(url, { ...options, headers });
}

export { supabase };

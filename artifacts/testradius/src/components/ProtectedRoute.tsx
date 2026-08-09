import { type ReactNode } from "react";
import { useAuth } from "@/lib/auth";

interface ProtectedRouteProps {
  children: ReactNode;
}

const IS_DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

/**
 * Redirects unauthenticated users to /login. While the session is resolving,
 * shows a minimal loading state.
 *
 * In DEMO_MODE (development only) the session check is skipped so the team
 * can test auth-protected pages without a real Supabase session.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { session, loading } = useAuth();

  // Skip auth in demo mode — backend also bypasses JWT validation.
  if (IS_DEMO_MODE) return <>{children}</>;

  if (loading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background text-foreground">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!session) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    return null;
  }

  return <>{children}</>;
}

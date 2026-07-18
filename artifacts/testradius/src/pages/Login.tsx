import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Github, Chrome, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { AlertCircle } from "lucide-react";

export function Login() {
  const { signInWithGitHub, signInWithGoogle } = useAuth();
  const [location] = useLocation();
  const isSignup = new URLSearchParams(location.split("?")[1] ?? "").get("mode") === "signup";
  const [mode, setMode] = useState<"login" | "signup">(isSignup ? "signup" : "login");
  const [error, setError] = useState<string | null>(null);
  const signup = mode === "signup";

  useEffect(() => {
    if (sessionStorage.getItem("auth_error") === "signup_required") {
      sessionStorage.removeItem("auth_error");
      setMode("signup");
      setError("No account found for that sign-in. Please sign up first to create your account.");
    }
  }, []);

  const toggle = (next: "login" | "signup") => {
    setMode(next);
    setError(null);
    const url = next === "signup" ? "/login?mode=signup" : "/login";
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="min-h-[100dvh] w-full bg-gradient-to-br from-primary/5 via-background to-[#3daa9a]/5 flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <Link href="/">
          <Button variant="ghost" className="mb-6 gap-2">
            <ArrowLeft className="h-4 w-4" /> Back to home
          </Button>
        </Link>

        <Card className="border-border/40 shadow-lg">
          <CardHeader className="text-center">
            <div className="inline-flex rounded-lg border border-border/40 p-1 mx-auto mb-4 bg-muted/40 w-fit">
              <button
                type="button"
                onClick={() => toggle("login")}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  !signup ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => toggle("signup")}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  signup ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                Sign up
              </button>
            </div>
            <CardTitle className="text-2xl font-bold">
              {signup ? "Create your TestRadius account" : "Sign in to TestRadius"}
            </CardTitle>
            <CardDescription>
              {signup
                ? "Sign up to run the Agentic Tester and get 50 free test runs."
                : "Welcome back. Sign in to continue to the Agentic Tester."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <Button
              variant="outline"
              className="w-full gap-2 h-11"
              onClick={() => signInWithGitHub(mode)}
            >
              <Github className="h-5 w-5" /> {signup ? "Sign up with GitHub" : "Continue with GitHub"}
            </Button>
            <Button
              variant="outline"
              className="w-full gap-2 h-11"
              onClick={() => signInWithGoogle(mode)}
            >
              <Chrome className="h-5 w-5" /> {signup ? "Sign up with Google" : "Continue with Google"}
            </Button>

            <p className="text-xs text-muted-foreground text-center mt-4">
              By continuing you agree to TestRadius's Terms of Service and Privacy Policy.
            </p>

            <p className="text-sm text-muted-foreground text-center mt-2">
              {signup ? (
                <>
                  Already have an account?{" "}
                  <button
                    type="button"
                    className="text-primary font-medium hover:underline"
                    onClick={() => toggle("login")}
                  >
                    Login
                  </button>
                </>
              ) : (
                <>
                  Don't have an account?{" "}
                  <button
                    type="button"
                    className="text-primary font-medium hover:underline"
                    onClick={() => toggle("signup")}
                  >
                    Sign up
                  </button>
                </>
              )}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

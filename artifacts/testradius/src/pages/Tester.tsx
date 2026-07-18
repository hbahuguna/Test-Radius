import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link, useLocation } from "wouter";
import { Layout } from "@/components/Layout";
import { Check, Copy, Loader2 } from "lucide-react";
import { RunForm } from "@/components/tester/RunForm";
import { defaultModelFor } from "@/components/tester/ModelSelector";
import { LiveProgress, type StepEvent } from "@/components/tester/LiveProgress";
import { RunHistory } from "@/components/tester/RunHistory";
import {
  streamRun,
  stopRun,
  getScreenshot,
  getCreditBalance,
  getRunHistory,
  getApiKeys,
  startCheckout,
  spendCredit,
  type Assertion,
  type RunHistoryItem,
  type CreditBalance,
  type UserApiKey,
} from "@/lib/agentic-api";
import { toast } from "sonner";

type RunStatus = "idle" | "running" | "done" | "failed" | "stopped";

export function Tester() {
  const { user, signOut } = useAuth();
  const [, navigate] = useLocation();
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [assertions, setAssertions] = useState<Assertion[]>([
    { type: "visibility", target: "" },
  ]);
  const [model, setModel] = useState("opencode");
  const [modelId, setModelId] = useState<string>(defaultModelFor("opencode"));

  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [history, setHistory] = useState<RunHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const [status, setStatus] = useState<RunStatus>("idle");
  const [success, setSuccess] = useState<boolean | null>(null);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const screenshotTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMeta = async () => {
    try {
      const [bal, hist, k] = await Promise.all([
        getCreditBalance(),
        getRunHistory(),
        getApiKeys(),
      ]);
      setCredits(bal);
      setHistory(hist);
      setKeys(k);
    } catch (e) {
      toast.error("Failed to load account data");
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopy = async () => {
    if (!generatedCode || copying) return;
    setCopying(true);
    try {
      const bal = await spendCredit("copy_test");
      setCredits(bal);
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      toast.success("Test copied to clipboard. 1 credit used.");
      setTimeout(() => setCopied(false), 2000);
    } catch (e: any) {
      if (e?.code === "insufficient_credits") {
        toast.error("No credits remaining. Redirecting to buy credits…");
        setTimeout(() => navigate("/pricing"), 1200);
      } else {
        toast.error(e?.message || "Failed to copy test");
      }
    } finally {
      setCopying(false);
    }
  };

  const handleRun = async () => {
    if (!url || !goal) return;
    setRunning(true);
    setStatus("running");
    setSuccess(null);
    setSteps([]);
    setThoughts([]);
    setGeneratedCode(null);
    setScreenshot(null);

    const controller = new AbortController();
    abortRef.current = controller;

    // Poll the live screenshot while the run is active.
    const pollScreenshot = async () => {
      const shot = await getScreenshot();
      if (shot?.screenshot) setScreenshot(shot.screenshot);
    };
    screenshotTimer.current = setInterval(pollScreenshot, 1500);
    pollScreenshot();

    const cleanedAssertions = assertions
      .filter((a) => (a.target || a.expected || a.pattern))
      .map((a) => ({
        type: a.type,
        ...(a.target ? { target: a.target } : {}),
        ...(a.expected ? { expected: a.expected } : {}),
        ...(a.pattern ? { pattern: a.pattern } : {}),
      }));

    try {
      await streamRun(
        {
          url,
          goal,
          assertions: cleanedAssertions,
          headless: true,
          model_provider: model,
          model: modelId,
        },
        {
          signal: controller.signal,
          onEvent: (evt) => {
            const e = evt as Record<string, any>;
            if (e.event === "thinking_delta" || e.event === "content_delta") {
              const text = (e.text as string) ?? "";
              if (text) setThoughts((prev) => [...prev, text]);
            } else if (e.event === "tool_call") {
              setSteps((prev) => [
                ...prev,
                {
                  step: prev.length + 1,
                  action: e.name,
                  target: e.arguments?.target ?? e.arguments?.value ?? "",
                  status: "running",
                },
              ]);
            } else if (e.event === "tool_result") {
              // Mark the most recent running step as done.
              setSteps((prev) => {
                const next = [...prev];
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].status === "running") {
                    next[i] = {
                      ...next[i],
                      status: e.ok === false ? "error" : "done",
                      detail: typeof e.result === "string" ? e.result.slice(0, 120) : undefined,
                    };
                    break;
                  }
                }
                return next;
              });
            } else if (e.event === "node") {
              if (e.screenshot) setScreenshot(e.screenshot);
              else if (typeof e.name === "string") {
                setSteps((prev) => [
                  ...prev,
                  { step: prev.length + 1, action: e.name, status: "done" },
                ]);
              }
            } else if (e.event === "screenshot") {
              if (e.screenshot) setScreenshot(e.screenshot);
            } else if (e.event === "done") {
              setStatus(e.success ? "done" : "failed");
              setSuccess(Boolean(e.success));
              if (typeof e.generated_code === "string") setGeneratedCode(e.generated_code);
            } else if (e.event === "error") {
              setStatus("failed");
            }
          },
        },
      );
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setStatus("stopped");
      } else {
        setStatus("failed");
        toast.error(err?.message || "Run failed");
      }
    } finally {
      if (screenshotTimer.current) clearInterval(screenshotTimer.current);
      setRunning(false);
      abortRef.current = null;
      loadMeta();
    }
  };

  const handleStop = () => {
    if (screenshotTimer.current) clearInterval(screenshotTimer.current);
    abortRef.current?.abort();
    stopRun().catch(() => {});
  };

  return (
    <Layout>
      <div className="relative min-h-[100dvh] w-full bg-background text-foreground pb-16">
        {/* Site-style radial gradient backdrop */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-primary/10 via-[#3daa9a]/5 to-background -z-10" />
        <div className="w-full max-w-[1600px] mx-auto px-6 pt-24">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.1]">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  Agentic Tester
                </span>
              </h1>
              <p className="text-muted-foreground text-sm mt-2">
                Run AI-powered browser tests against any URL.
              </p>
            </div>
          <div className="flex items-center gap-3">
            {credits && (
              <>
                <Badge variant={credits.credits_remaining > 0 ? "default" : "destructive"}>
                  {credits.credits_remaining} credits left
                </Badge>
                {credits.credits_remaining === 0 && (
                  <Button
                    size="sm"
                    onClick={() => startCheckout("price_credit_pack_10").catch(() => toast.error("Checkout failed"))}
                  >
                    Buy Credits
                  </Button>
                )}
              </>
            )}
            <Link href="/settings">
              <Button variant="ghost" size="sm">
                Settings
              </Button>
            </Link>
            <Button variant="outline" size="sm" onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        </div>

        {/* Main workspace */}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,420px)_1fr] gap-6">
          {/* Left column: config + reasoning */}
          <div className="space-y-6">
            <Card className="rounded-xl border-border shadow-lg">
              <CardHeader>
                <CardTitle>New Test Run</CardTitle>
              </CardHeader>
              <CardContent>
                <RunForm
                  url={url}
                  goal={goal}
                  assertions={assertions}
                  model={model}
                  modelId={modelId}
                  keys={keys}
                  loading={running}
                  onUrlChange={setUrl}
                  onGoalChange={setGoal}
                  onAssertionsChange={setAssertions}
                  onModelChange={setModel}
                  onModelIdChange={setModelId}
                  onRun={handleRun}
                />
                {running && (
                  <Button variant="destructive" className="w-full mt-3" onClick={handleStop}>
                    Stop Run
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-xl border-border shadow-lg">
              <CardHeader>
                <CardTitle>Model Reasoning</CardTitle>
              </CardHeader>
              <CardContent>
                <LiveProgress
                  steps={[]}
                  thoughts={thoughts}
                  screenshot={null}
                  status={status}
                  success={success}
                />
              </CardContent>
            </Card>
          </div>

          {/* Right column: big browser view + steps */}
          <div className="space-y-6">
            <Card className="rounded-xl border-border shadow-lg">
              <CardHeader>
                <CardTitle>Live Browser</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-muted rounded-xl overflow-hidden w-full aspect-[16/10] min-h-[520px] flex items-center justify-center ring-1 ring-border/50">
                  {screenshot ? (
                    <img
                      src={`data:image/png;base64,${screenshot}`}
                      alt="Live browser"
                      className="w-full h-full object-contain"
                    />
                  ) : status === "running" ? (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span className="text-sm">Loading browser…</span>
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">No preview yet</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  {screenshot ? "Live viewport updates as the agent navigates." : "Start a run to see the live browser."}
                </p>
              </CardContent>
            </Card>

            <Card className="rounded-xl border-border shadow-lg">
              <CardHeader>
                <CardTitle>Run Steps</CardTitle>
              </CardHeader>
              <CardContent>
                <LiveProgress
                  steps={steps}
                  thoughts={[]}
                  screenshot={null}
                  status={status}
                  success={success}
                />
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Generated test code */}
        {generatedCode && (
          <Card className="mt-6 rounded-xl border-border shadow-lg">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>Generated Test</CardTitle>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleCopy}
                disabled={copying}
              >
                {copying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copying ? "Copying…" : copied ? "Copied" : "Copy (1 credit)"}
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="bg-zinc-950 text-zinc-100 rounded-xl p-4 overflow-x-auto text-sm font-mono max-h-[480px] overflow-y-auto">
                <code>{generatedCode}</code>
              </pre>
            </CardContent>
          </Card>
        )}

        {/* History */}
        <Card className="mt-6 rounded-xl border-border shadow-lg">
          <CardHeader>
            <CardTitle>Run History</CardTitle>
          </CardHeader>
          <CardContent>
            <RunHistory runs={history} loading={historyLoading} />
          </CardContent>
        </Card>
        </div>
      </div>
    </Layout>
  );
}

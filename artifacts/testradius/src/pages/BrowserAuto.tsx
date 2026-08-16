import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import posthog from "@/lib/posthog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { Loader2 } from "lucide-react";
import { RunForm } from "@/components/tester/RunForm";
import { defaultModelFor } from "@/components/tester/ModelSelector";
import { LiveProgress, type StepEvent } from "@/components/tester/LiveProgress";
import { RunHistory } from "@/components/tester/RunHistory";
import { InlineChat } from "@/components/tester/InlineChat";
import {
  streamBrowserAutoRun,
  stopBrowserAutoRun,
  getBrowserAutoScreenshot,
  getBrowserAutoRunHistory,
  getApiKeys,
  type BrowserAutoRunHistoryItem,
  type UserApiKey,
} from "@/lib/browser-auto-api";
import { toast } from "sonner";

type RunStatus = "idle" | "running" | "done" | "failed" | "stopped";

export function BrowserAuto() {
  const { user, signOut } = useAuth();

  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState("opencode");
  const [modelId, setModelId] = useState<string>(defaultModelFor("opencode"));
  const [assertions, setAssertions] = useState<Array<{ type: "visibility" | "text" | "url"; target?: string; expected?: string; pattern?: string; description?: string }>>([
    { type: "visibility", target: "" },
  ]);

  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [history, setHistory] = useState<BrowserAutoRunHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const [status, setStatus] = useState<RunStatus>("idle");
  const [success, setSuccess] = useState<boolean | null>(null);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const screenshotTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMeta = async () => {
    try {
      const [hist, k] = await Promise.all([
        getBrowserAutoRunHistory(),
        getApiKeys(),
      ]);
      setHistory(hist);
      setKeys(k);
    } catch {
      toast.error("Failed to load account data");
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadMeta();

    const pollScreenshot = async () => {
      const shot = await getBrowserAutoScreenshot();
      if (shot?.screenshot) setScreenshot(shot.screenshot);
    };
    screenshotTimer.current = setInterval(pollScreenshot, 1500);
    pollScreenshot();

    return () => {
      if (screenshotTimer.current) clearInterval(screenshotTimer.current);
    };
  }, []);

  const handleRun = async () => {
    if (!url || !goal) return;
    setRunning(true);
    setStatus("running");
    setSuccess(null);
    setSteps([]);
    setScreenshot(null);
    setRunError(null);
    posthog.capture("browser_auto_run_started", {
      assertion_count: assertions.filter((assertion) => assertion.target || assertion.expected || assertion.pattern).length,
      model_provider: model,
    });

    const controller = new AbortController();
    abortRef.current = controller;

    const cleanedAssertions = assertions
      .filter((a) => (a.target || a.expected || a.pattern))
      .map((a) => ({
        type: a.type,
        ...(a.target ? { target: a.target } : {}),
        ...(a.expected ? { expected: a.expected } : {}),
        ...(a.pattern ? { pattern: a.pattern } : {}),
      }));

    try {
      await streamBrowserAutoRun(
        {
          url,
          goal,
          assertions: cleanedAssertions,
          headless: true,
          use_vision: true,
          model_provider: model,
          model: modelId,
        },
        {
          signal: controller.signal,
          onEvent: (evt) => {
            const e = evt as Record<string, any>;
            if (e.event === "thinking") {
              // Show thinking as a step detail
              setSteps((prev) => {
                const next = [...prev];
                if (next.length > 0) {
                  const last = next[next.length - 1];
                  next[next.length - 1] = {
                    ...last,
                    detail: e.text || last.detail,
                  };
                }
                return next;
              });
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
            } else if (e.event === "screenshot") {
              if (e.screenshot) setScreenshot(e.screenshot);
            } else if (e.event === "done") {
              posthog.capture("browser_auto_run_completed", {
                model_provider: model,
                success: Boolean(e.success),
              });
              setStatus(e.success ? "done" : "failed");
              setSuccess(Boolean(e.success));
              if (!e.success && typeof e.message === "string") setRunError(e.message);
            } else if (e.event === "error") {
              posthog.capture("browser_auto_run_completed", {
                model_provider: model,
                success: false,
              });
              setStatus("failed");
              if (typeof e.message === "string") setRunError(e.message);
            }
          },
        },
      );
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setStatus("stopped");
      } else {
        posthog.capture("browser_auto_run_completed", {
          model_provider: model,
          success: false,
        });
        setStatus("failed");
        if (err?.code === "no_api_key") {
          toast.error(err?.message || "No API key configured. Redirecting to Settings...");
          setTimeout(() => window.location.href = "/settings", 1200);
        } else {
          toast.error(err?.message || "Run failed");
        }
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    if (screenshotTimer.current) clearInterval(screenshotTimer.current);
    abortRef.current?.abort();
    stopBrowserAutoRun().catch(() => {});
  };

  return (
    <Layout>
      <div className="relative min-h-[100dvh] w-full bg-background text-foreground pb-16">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-primary/10 via-[#3daa9a]/5 to-background -z-10" />
        <div className="w-full max-w-[1600px] mx-auto px-6 pt-24">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.1]">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  Browser Auto
                </span>
              </h1>
              <p className="text-muted-foreground text-sm mt-2">
                Browser-use style AI agent — automated browser testing.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/settings">
                <Button variant="ghost" size="sm">Settings</Button>
              </Link>
              <Button variant="outline" size="sm" onClick={() => signOut()}>Sign out</Button>
            </div>
          </div>

          {/* Main workspace */}
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,420px)_1fr] gap-6">
            {/* Left column: config */}
            <div className="space-y-6">
              <Card className="rounded-xl border-border shadow-lg">
                <CardHeader>
                  <CardTitle>New Run</CardTitle>
                </CardHeader>
                <CardContent>
                  <RunForm
                    url={url}
                    goal={goal}
                    assertions={assertions}
                    model={model}
                    modelId={modelId}
                    mode="reactive"
                    keys={keys}
                    loading={running}
                    onUrlChange={setUrl}
                    onGoalChange={setGoal}
                    onAssertionsChange={setAssertions}
                    onModelChange={setModel}
                    onModelIdChange={setModelId}
                    onModeChange={() => {}}
                    onRun={handleRun}
                  />
                  {running && (
                    <Button variant="destructive" className="w-full mt-3" onClick={handleStop}>
                      Stop Run
                    </Button>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Right column: browser view + steps */}
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
                        <span className="text-sm">Loading browser...</span>
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
                    screenshot={null}
                    status={status}
                    success={success}
                  />
                  {runError && status === "failed" && (
                    <div className="mt-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                      <p className="text-sm font-medium text-destructive mb-1">Failure Reason</p>
                      <p className="text-sm text-destructive/80 font-mono whitespace-pre-wrap">{runError}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Inline chat */}
              {(status === "done" || status === "failed" || status === "stopped") && (
                <InlineChat
                  goal={goal}
                  url={url}
                  steps={steps.map((s) => ({ name: s.action || "unknown", args: { target: s.target }, result: s.detail }))}
                  runError={runError}
                  modelProvider={model}
                  modelId={modelId}
                />
              )}
            </div>
          </div>

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

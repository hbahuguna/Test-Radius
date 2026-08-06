import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { Layout } from "@/components/Layout";
import { AgentChatPanel, type UserMessageEvent } from "@/components/browser-agent/AgentChatPanel";
import { LiveBrowserView } from "@/components/browser-agent/LiveBrowserView";
import { ChatInput } from "@/components/browser-agent/ChatInput";
import { ControlBar } from "@/components/browser-agent/ControlBar";
import { ModelSelector, defaultModelFor } from "@/components/tester/ModelSelector";
import { AssertionEditor } from "@/components/tester/AssertionEditor";
import { RunHistory } from "@/components/tester/RunHistory";
import {
  startBrowserAgentRun,
  sendBrowserAgentChat,
  stopBrowserAgentRun,
  getBrowserAgentScreenshot,
  getBrowserAgentRunHistory,
  getBrowserAgentApiKeys,
  generatePlaywrightCode,
  savePlaywrightCode,
  repairPlaywrightCode,
  runPlaywrightCode,
  streamPlaywrightCodeRun,
  type AgentEvent,
  type AgentStepEvent,
  type AgentLoadingEvent,
  type AgentDoneEvent,
  type AgentErrorEvent,
  type UserApiKey,
  type BrowserAgentRunHistoryItem,
  type GeneratedPlaywrightCode,
} from "@/lib/browser-agent-api";
import { type Assertion } from "@/lib/agentic-api";
import { toast } from "sonner";

type RunStatus = "idle" | "running" | "completed" | "failed" | "stopped";

type ChatEvent = AgentStepEvent | AgentLoadingEvent | AgentDoneEvent | AgentErrorEvent | UserMessageEvent;

/** Validate screenshot data URL — must be a real image with actual base64 data (min 300 chars). */
function isValidScreenshot(s: string | null): s is string {
  return !!s && s.startsWith("data:image/") && s.includes(",") && s.length > 300;
}

export function BrowserAgent() {
  const { user, signOut } = useAuth();

  // Form state
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [modelProvider, setModelProvider] = useState("poolside");
  const [modelId, setModelId] = useState<string>(defaultModelFor("poolside"));
  const [assertions, setAssertions] = useState<Assertion[]>([]);
  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [history, setHistory] = useState<BrowserAgentRunHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Run state
  const [status, setStatus] = useState<RunStatus>("idle");
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [completedRunId, setCompletedRunId] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [codeWarnings, setCodeWarnings] = useState<string[]>([]);
  const [traceDiagnostics, setTraceDiagnostics] = useState<GeneratedPlaywrightCode["traceDiagnostics"]>(undefined);
  const [codeLoading, setCodeLoading] = useState(false);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [scriptVersion, setScriptVersion] = useState<number | null>(null);
  const [codeRunEvents, setCodeRunEvents] = useState<Record<string, unknown>[]>([]);
  const [codeRunLoading, setCodeRunLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const screenshotTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasReceivedFirstStep = useRef(false);
  const currentRunIdRef = useRef<string | null>(null);

  // Load API keys and run history on mount
  useEffect(() => {
    const loadMeta = async () => {
      try {
        const [hist, k] = await Promise.all([
          getBrowserAgentRunHistory(),
          getBrowserAgentApiKeys(),
        ]);
        setHistory(hist);
        setKeys(k);
      } catch {
        // Silent — non-critical
      } finally {
        setHistoryLoading(false);
      }
    };
    loadMeta();
  }, []);

  // Get latest step event
  const latestStep = events
    .filter((e): e is AgentStepEvent => e.event === "step")
    .pop();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (screenshotTimer.current) clearInterval(screenshotTimer.current);
      abortRef.current?.abort();
    };
  }, []);

  // Initial screenshot polling: capture browser state while agent starts up
  useEffect(() => {
    if (status !== "running") {
      if (screenshotTimer.current) {
        clearInterval(screenshotTimer.current);
        screenshotTimer.current = null;
      }
      hasReceivedFirstStep.current = false;
      return;
    }

    // Don't start polling if we already got a step event
    if (hasReceivedFirstStep.current) return;

    // Poll every 500ms until first step arrives
    screenshotTimer.current = setInterval(async () => {
      if (hasReceivedFirstStep.current) {
        clearInterval(screenshotTimer.current!);
        screenshotTimer.current = null;
        return;
      }

      try {
        const result = await getBrowserAgentScreenshot();
        if (isValidScreenshot(result.screenshot)) {
          setScreenshot(result.screenshot);
        }
      } catch {
        // Ignore polling errors
      }
    }, 500);

    // Safety timeout: stop polling after 30s even if no step received
    const timeout = setTimeout(() => {
      if (screenshotTimer.current) {
        clearInterval(screenshotTimer.current);
        screenshotTimer.current = null;
      }
    }, 30000);

    return () => {
      if (screenshotTimer.current) {
        clearInterval(screenshotTimer.current);
        screenshotTimer.current = null;
      }
      clearTimeout(timeout);
    };
  }, [status]);

  const handleStart = useCallback(async () => {
    if (!url || !goal) {
      toast.error("Please enter a URL and goal");
      return;
    }

    setStatus("running");
    setEvents([]);
    setScreenshot(null);
    setRunError(null);
    setCompletedRunId(null);
    setGeneratedCode(null);
    setCodeWarnings([]);
    setTraceDiagnostics(undefined);
    setScriptId(null);
    setScriptVersion(null);
    setCodeRunEvents([]);
    setCurrentUrl(url);
    setCurrentTitle(null);

    const controller = new AbortController();
    abortRef.current = controller;

    // Build model ID in provider/model format
    const fullModelId = modelProvider === "opencode"
      ? modelId
      : `${modelProvider}/${modelId}`;

    // Clean assertions
    const cleanedAssertions = assertions
      .filter((a) => a.target || a.expected || a.pattern)
      .map((a) => ({
        type: a.type,
        ...(a.target ? { target: a.target } : {}),
        ...(a.expected ? { expected: a.expected } : {}),
        ...(a.pattern ? { pattern: a.pattern } : {}),
      }));

    try {
      await startBrowserAgentRun(
        {
          url,
          goal,
          model_id: fullModelId,
          model_provider: modelProvider,
          assertions: cleanedAssertions.length > 0 ? cleanedAssertions : undefined,
          max_steps: 30,
          use_vision: false,
          keep_alive: true,
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.event !== "started") {
              setEvents((prev) => [...prev, event]);
            }

            if (event.event === "started") {
              currentRunIdRef.current = event.run_id;
            } else if (event.event === "loading") {
              if (!hasReceivedFirstStep.current) {
                hasReceivedFirstStep.current = true;
                if (screenshotTimer.current) {
                  clearInterval(screenshotTimer.current);
                  screenshotTimer.current = null;
                }
              }
              if (isValidScreenshot(event.screenshot)) setScreenshot(event.screenshot);
              if (event.url) setCurrentUrl(event.url);
              if (event.title) setCurrentTitle(event.title);
            } else if (event.event === "step") {
              if (!hasReceivedFirstStep.current) {
                hasReceivedFirstStep.current = true;
                if (screenshotTimer.current) {
                  clearInterval(screenshotTimer.current);
                  screenshotTimer.current = null;
                }
              }
              if (isValidScreenshot(event.screenshot)) {
                setScreenshot(event.screenshot);
              }
              if (event.url) setCurrentUrl(event.url);
              if (event.title) setCurrentTitle(event.title);
            } else if (event.event === "done") {
              setCompletedRunId(currentRunIdRef.current);
              setStatus(event.success ? "completed" : "failed");
            } else if (event.event === "error") {
              setStatus("failed");
              setRunError(event.message);
            }
          },
          onError: (error) => {
            if (screenshotTimer.current) {
              clearInterval(screenshotTimer.current);
              screenshotTimer.current = null;
            }
            setStatus("failed");
            setRunError(error.message);
            toast.error(error.message);
          },
        },
      );
    } catch (err: any) {
      if (screenshotTimer.current) {
        clearInterval(screenshotTimer.current);
        screenshotTimer.current = null;
      }
      if (err?.name === "AbortError") {
        setStatus("stopped");
      } else {
        setStatus("failed");
        setRunError(err?.message || "Run failed");
        toast.error(err?.message || "Run failed");
      }
    } finally {
      setChatLoading(false);
      abortRef.current = null;
      currentRunIdRef.current = null;
      getBrowserAgentRunHistory()
        .then(setHistory)
        .catch(() => {});
    }
  }, [url, goal, modelProvider, modelId, assertions]);

  const handleStop = useCallback(async () => {
    if (screenshotTimer.current) {
      clearInterval(screenshotTimer.current);
      screenshotTimer.current = null;
    }
    hasReceivedFirstStep.current = false;
    abortRef.current?.abort();
    await stopBrowserAgentRun(currentRunIdRef.current ?? undefined);
    setStatus("stopped");
    currentRunIdRef.current = null;
    getBrowserAgentRunHistory()
      .then(setHistory)
      .catch(() => {});
  }, []);

  const handleClear = useCallback(() => {
    if (screenshotTimer.current) {
      clearInterval(screenshotTimer.current);
      screenshotTimer.current = null;
    }
    hasReceivedFirstStep.current = false;
    setStatus("idle");
    setEvents([]);
    setScreenshot(null);
    setRunError(null);
    setCurrentUrl(null);
    setCurrentTitle(null);
    setCompletedRunId(null);
    setGeneratedCode(null);
    setCodeWarnings([]);
    setTraceDiagnostics(undefined);
    setScriptId(null);
    setScriptVersion(null);
    setCodeRunEvents([]);
  }, []);

  const handleGenerateCode = useCallback(async () => {
    if (!completedRunId || codeLoading) return;
    setCodeLoading(true);
    try {
      const result = await generatePlaywrightCode(completedRunId);
      setGeneratedCode(result.code);
      setCodeWarnings(result.warnings);
      setTraceDiagnostics(result.traceDiagnostics);
      setScriptId(result.scriptId);
      setScriptVersion(result.version);
      toast.success("Playwright code generated from the agent trace");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Code generation failed");
    } finally {
      setCodeLoading(false);
    }
  }, [completedRunId, codeLoading]);

  const handleSaveCode = useCallback(async () => {
    if (!scriptId || generatedCode === null) return;
    try {
      const saved = await savePlaywrightCode(scriptId, generatedCode);
      setScriptId(saved.scriptId);
      setScriptVersion(saved.version);
      setCodeWarnings(saved.warnings);
      toast.success(`Saved script version ${saved.version}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save script");
    }
  }, [generatedCode, scriptId]);

  const handleRepairCode = useCallback(async () => {
    if (!scriptId) return;
    try {
      const repaired = await repairPlaywrightCode(scriptId, String(codeRunEvents.find((event) => event.event === "code_step_failed")?.error || ""));
      setScriptId(repaired.scriptId);
      setScriptVersion(repaired.version);
      setGeneratedCode(repaired.code);
      setCodeWarnings(repaired.warnings);
      toast.success(`Created repaired script version ${repaired.version}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to repair script");
    }
  }, [codeRunEvents, scriptId]);

  const handleRunCode = useCallback(async () => {
    if (!scriptId || codeRunLoading) return;
    setCodeRunLoading(true);
    setCodeRunEvents([]);
    try {
      const run = await runPlaywrightCode(scriptId, url);
      await streamPlaywrightCodeRun(run.codeRunId, (event) => {
        setCodeRunEvents((previous) => [...previous, event]);
        if (typeof event.screenshot === "string") setScreenshot(event.screenshot);
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Code execution failed");
    } finally {
      setCodeRunLoading(false);
    }
  }, [codeRunLoading, scriptId, url]);

  const handleChat = useCallback(
    async (message: string) => {
      // Add user message to activity panel
      const userMsg: UserMessageEvent = {
        event: "user_message",
        message,
        timestamp: new Date().toLocaleTimeString(),
      };
      setEvents((prev) => [...prev, userMsg]);

      setChatLoading(true);
      const success = await sendBrowserAgentChat(message, currentRunIdRef.current ?? undefined);
      setChatLoading(false);

      if (!success) {
        toast.error("Failed to send message");
      }
    },
    [],
  );

  const isRunning = status === "running";

  return (
    <Layout>
      <div className="relative min-h-[100dvh] w-full bg-background text-foreground pb-16">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-primary/10 via-[#3daa9a]/5 to-background -z-10" />

        <div className="w-full max-w-[1800px] mx-auto px-6 pt-24">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <div>
              <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.1]">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-[#3daa9a]">
                  Browser Agent
                </span>
              </h1>
              <p className="text-muted-foreground text-sm mt-2">
                AI-powered browser automation with live preview and chat.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/browser-auto">
                <Button variant="ghost" size="sm">Browser Auto</Button>
              </Link>
              <Link href="/settings">
                <Button variant="ghost" size="sm">Settings</Button>
              </Link>
              <Button variant="outline" size="sm" onClick={() => signOut()}>
                Sign out
              </Button>
            </div>
          </div>

          {/* Main Layout */}
          <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-6">
            {/* Left Column: Config + Controls */}
            <div className="space-y-4">
              {/* Run Config */}
              <Card className="rounded-xl border-border shadow-lg">
                <CardHeader className="pb-4">
                  <CardTitle className="text-lg">Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="url">URL</Label>
                    <Input
                      id="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://example.com"
                      disabled={isRunning}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="goal">Goal</Label>
                    <Textarea
                      id="goal"
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      placeholder="What should the agent do?"
                      rows={3}
                      disabled={isRunning}
                    />
                  </div>

                  {/* Model Selector */}
                  <div className="space-y-2">
                    <Label>Model</Label>
                    <ModelSelector
                      provider={modelProvider}
                      modelId={modelId}
                      onProviderChange={setModelProvider}
                      onModelIdChange={setModelId}
                      keys={keys}
                    />
                  </div>

                  {/* Assertions */}
                  <div className="space-y-2">
                    <Label>Assertions (optional)</Label>
                    <AssertionEditor
                      assertions={assertions}
                      onChange={setAssertions}
                    />
                  </div>

                  <ControlBar
                    status={status}
                    onStart={handleStart}
                    onStop={handleStop}
                    onClear={handleClear}
                    startDisabled={!url || !goal}
                  />
                </CardContent>
              </Card>

              {/* Agent Info */}
              {(status === "completed" || status === "failed") && (
                <Card className="rounded-xl border-border shadow-lg">
                  <CardContent className="p-4">
                    {runError ? (
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-destructive">Error</p>
                        <p className="text-sm text-destructive/80 font-mono whitespace-pre-wrap">
                          {runError}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-green-600">
                          {status === "completed" ? "Task Completed" : "Task Stopped"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {events.filter((e) => e.event === "step").length} steps taken
                        </p>
                        {completedRunId && (
                          <Button size="sm" onClick={handleGenerateCode} disabled={codeLoading}>
                            {codeLoading ? "Generating…" : "Generate Playwright Code"}
                          </Button>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>

            {/* Right Column: Browser + Chat */}
            <div className="flex min-w-0 flex-col gap-4">
              {/* Live Browser View */}
              <Card className="rounded-xl border-border shadow-lg h-[400px] shrink-0 overflow-hidden">
                <CardContent className="p-0 h-full">
                  <LiveBrowserView
                    screenshot={screenshot}
                    status={status}
                    url={currentUrl}
                    title={currentTitle}
                  />
                </CardContent>
              </Card>

              {/* Agent Activity (Steps) */}
              <Card className="rounded-xl border-border shadow-lg flex-none min-w-0 h-[min(60vh,720px)] min-h-[360px] sm:min-h-[420px] overflow-hidden">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">Agent Activity</CardTitle>
                </CardHeader>
                <CardContent className="min-w-0 p-0 h-[calc(100%-60px)] overflow-hidden">
                  <AgentChatPanel steps={events} status={status} />
                </CardContent>
              </Card>

              {/* Chat Input */}
              {(isRunning || status === "completed" || status === "failed" || status === "stopped") && (
                <Card className="rounded-xl border-border shadow-lg">
                  <CardContent className="p-0">
                    <ChatInput
                      onSend={handleChat}
                      disabled={!isRunning}
                      loading={chatLoading}
                      placeholder={
                        isRunning
                          ? "Send a follow-up task to the agent..."
                          : "Agent is not running"
                      }
                    />
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          {generatedCode && (
            <Card className="mt-6 rounded-xl border-border shadow-lg">
              <CardHeader>
                <CardTitle>Generated Playwright Code</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Generated from the completed Browser Agent action trace. Review and edit before reuse.
                </p>
                {traceDiagnostics && (
                  <p className="text-xs text-muted-foreground">
                    Trace: {traceDiagnostics.stepCount} steps, {traceDiagnostics.actionCount} actions ({traceDiagnostics.source})
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={handleSaveCode} disabled={!scriptId}>Save Version {scriptVersion ?? ""}</Button>
                  <Button size="sm" variant="secondary" onClick={handleRunCode} disabled={!scriptId || codeRunLoading}>
                    {codeRunLoading ? "Running…" : "Run Code"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleRepairCode} disabled={!scriptId}>Repair From Trace</Button>
                </div>
                {codeWarnings.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                    {codeWarnings.map((warning) => <p key={warning}>{warning}</p>)}
                  </div>
                )}
                <Textarea
                  value={generatedCode}
                  onChange={(event) => setGeneratedCode(event.target.value)}
                  spellCheck={false}
                  className="min-h-[560px] resize-y bg-zinc-950 p-4 font-mono text-sm text-zinc-100"
                  aria-label="Generated Playwright code editor"
                />
                {codeRunEvents.length > 0 && (
                  <pre className="max-h-[260px] overflow-y-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                    {codeRunEvents.map((event, index) => `${index + 1}. ${String(event.event)}${event.name ? `: ${String(event.name)}` : ""}${event.error ? ` — ${String(event.error)}` : ""}`).join("\n")}
                  </pre>
                )}
              </CardContent>
            </Card>
          )}

          {/* Run History */}
          <Card className="mt-6 rounded-xl border-border shadow-lg">
            <CardHeader>
              <CardTitle className="text-lg">Run History</CardTitle>
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

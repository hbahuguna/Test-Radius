import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModelSelector, defaultModelFor } from "@/components/tester/ModelSelector";
import { type UserApiKey } from "@/lib/agentic-api";
import {
  startRecord,
  startReplay,
  startBrowse,
  stopRun,
  listTests,
  listRuns,
  deleteTest,
  deleteStep,
  getScreenshot,
  type QfTest,
  type QfRun,
  type QfEvent,
} from "@/lib/queryfirst-api";
import { toast } from "sonner";
import {
  Play,
  Square,
  RefreshCw,
  Trash2,
  Activity,
  Camera,
  FlaskConical,
  RotateCcw,
  Wrench,
  Globe,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

type Mode = "idle" | "recording" | "replaying" | "browsing";
type Status = "idle" | "running" | "done" | "error";

interface StepLog {
  label: string;
  status: "passed" | "failed" | "skipped" | "planned" | "info" | "healed";
  detail?: string;
  timestamp: number;
}

function isValidScreenshot(s: string | null): s is string {
  return !!s && s.startsWith("data:image/") && s.includes(",") && s.length > 300;
}

export function QueryFirstDemo() {
  const { user } = useAuth();

  // Form state
  const [query, setQuery] = useState("register a user on the signup page");
  const [entryUrl, setEntryUrl] = useState("http://localhost:3123/signup");
  const [variables, setVariables] = useState('{"name":"Ada","email":"ada@example.com"}');
  const [provider, setProvider] = useState("google");
  const [modelId, setModelId] = useState(defaultModelFor("google"));
  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [redesign, setRedesign] = useState(false);

  // Run state
  const [mode, setMode] = useState<Mode>("idle");
  const [status, setStatus] = useState<Status>("idle");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepLog[]>([]);
  const [milestones, setMilestones] = useState<string[]>([]);
  const [currentMilestone, setCurrentMilestone] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ ok: boolean; llmCalls?: number; selfHealed?: number; error?: string; testId?: number } | null>(null);

  // Tests list
  const [tests, setTests] = useState<QfTest[]>([]);
  const [testsLoading, setTestsLoading] = useState(true);
  const [selectedTest, setSelectedTest] = useState<number | null>(null);
  const [runs, setRuns] = useState<QfRun[]>([]);
  const [stepsOpen, setStepsOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const screenshotTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load API keys + tests on mount
  useEffect(() => {
    const load = async () => {
      try {
        const k = await import("@/lib/agentic-api").then((m) => m.getApiKeys());
        setKeys(k);
      } catch { /* */ }
      try {
        const res = await listTests();
        setTests(res.tests);
      } catch { /* */ }
      setTestsLoading(false);
    };
    load();
  }, []);

  // Screenshot polling during runs
  useEffect(() => {
    if (mode === "idle") {
      if (screenshotTimer.current) { clearInterval(screenshotTimer.current); screenshotTimer.current = null; }
      return;
    }
    screenshotTimer.current = setInterval(async () => {
      try {
        const res = await getScreenshot();
        if (isValidScreenshot(res.screenshot)) setScreenshot(res.screenshot);
      } catch { /* */ }
    }, 500);
    return () => { if (screenshotTimer.current) { clearInterval(screenshotTimer.current); screenshotTimer.current = null; } };
  }, [mode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  // Load runs when a test is selected
  useEffect(() => {
    setStepsOpen(false);
    if (selectedTest === null) { setRuns([]); return; }
    listRuns(selectedTest).then((r) => setRuns(r.runs)).catch(() => setRuns([]));
  }, [selectedTest]);

  const refreshTests = useCallback(async () => {
    try {
      const res = await listTests();
      setTests(res.tests);
    } catch { /* */ }
  }, []);

  const addStep = useCallback((step: StepLog) => {
    setSteps((prev) => [...prev, step]);
  }, []);

  const handleEvent = useCallback((event: QfEvent) => {
    switch (event.event) {
      case "started":
        addStep({ label: event.kind === "record" ? "Recording started" : "Replay started", status: "info", timestamp: Date.now() });
        break;
      case "record":
        if (event.type === "milestones" && event.milestones) {
          setMilestones(event.milestones);
          addStep({ label: `Milestones: ${event.milestones.length} planned`, status: "planned", detail: event.milestones.join(" → "), timestamp: Date.now() });
        } else if (event.type === "plan") {
          if (event.currentMilestone) setCurrentMilestone(event.currentMilestone);
          const acts = (event.actions as { type: string }[] | undefined) ?? [];
          if (acts.length > 0) addStep({ label: `Turn ${event.turn}: planned ${acts.length} action(s)`, status: "planned", detail: acts.map((a) => a.type).join(", "), timestamp: Date.now() });
          if (event.done) addStep({ label: `Turn ${event.turn}: agent declared done`, status: "info", timestamp: Date.now() });
        } else if (event.type === "step") {
          if (event.screenshot && isValidScreenshot(event.screenshot)) {
            setScreenshot(event.screenshot);
          }
          // Browser-use format: action is an array of QfActionTrace
          const actions = event.action as unknown[] | undefined ?? [];
          if (actions.length > 0) {
            for (const act of actions) {
              const a = act as { action?: string; raw?: Record<string, unknown> | null; element?: Record<string, unknown> | null };
              const actionName = a.action ?? a.raw?.name ?? "unknown";
              const raw = a.raw as Record<string, unknown> | undefined;
              // browser-use 2.x nests params under the action name: {"click": {"index": 3}}
              const firstKey = raw ? Object.keys(raw)[0] : undefined;
              const params = firstKey && typeof raw![firstKey] === "object" && raw![firstKey] !== null
                ? (raw![firstKey] as Record<string, unknown>)
                : raw;
              let desc = actionName;
              if (params) {
                if (params.url) desc += ` ${params.url}`;
                if (params.text) desc += ` "${params.text}"`;
                if (params.value) desc += ` "${params.value}"`;
              }
              const element = a.element as Record<string, unknown> | null;
              if (element) {
                const attrs = element.attributes as Record<string, string> | undefined;
                if (attrs?.["data-testid"]) desc += ` [data-testid="${attrs["data-testid"]}"]`;
                if (attrs?.id) desc += ` #${attrs.id}`;
              }
              addStep({ label: `Step ${event.stepIndex}: ${desc}`, status: event.ok ? "passed" : "failed", detail: event.error, timestamp: Date.now() });
            }
          } else {
            addStep({ label: `Step ${event.stepIndex}`, status: event.ok ? "passed" : "failed", detail: event.error, timestamp: Date.now() });
          }
        } else if (event.type === "loading") {
          if (event.screenshot && isValidScreenshot(event.screenshot)) {
            setScreenshot(event.screenshot);
          }
          addStep({ label: `Loading ${event.url ?? ""}`, status: "info", timestamp: Date.now() });
        } else if (event.type === "guard") {
          addStep({ label: `Loop guard fired (turn ${event.turn})`, status: "info", detail: event.reason, timestamp: Date.now() });
        } else if (event.type === "error") {
          addStep({ label: `Error (turn ${event.turn})`, status: "failed", detail: event.error, timestamp: Date.now() });
        }
        break;
      case "replay":
        if (event.type === "step") {
          const healed = event.healed;
          addStep({ label: `${event.idx + 1}. ${event.intent}`, status: healed ? "healed" : event.status, detail: healed ? `Healed → ${healed}` : event.status === "failed" ? (event.detail as { error?: string }).error : undefined, timestamp: Date.now() });
        }
        break;
      case "browse":
        if (event.type === "step_start") {
          const stepNum = (event.step ?? 0) + 1;
          const goal = event.nextGoal ? ` — ${event.nextGoal}` : "";
          const mem = event.memory ? ` [${event.memory}]` : "";
          addStep({ label: `Step ${stepNum}${goal}`, status: "planned", detail: mem || undefined, timestamp: Date.now() });
        } else if (event.type === "action") {
          const p = event.params ?? {};
          const desc = event.name + (p.ref ? ` ref=${p.ref}` : "") + (p.value ? ` "${p.value}"` : "") + (p.url ? ` ${p.url}` : "") + (p.text ? ` "${p.text}"` : "");
          addStep({
            label: `  ↳ ${desc}`,
            status: event.ok ? "passed" : "failed",
            detail: event.error,
            timestamp: Date.now(),
          });
        } else if (event.type === "guard") {
          addStep({ label: `Loop guard (step ${(event.step ?? 0) + 1})`, status: "info", detail: event.message, timestamp: Date.now() });
        } else if (event.type === "done") {
          addStep({
            label: `Browse ${event.success ? "complete" : "failed"}`,
            status: event.success ? "passed" : "failed",
            detail: event.text,
            timestamp: Date.now(),
          });
        }
        break;
      case "done":
        setRunResult({ ok: event.ok, llmCalls: event.llmCalls, selfHealed: event.selfHealed, error: event.error, testId: event.testId });
        setStatus(event.ok ? "done" : "error");
        setMode("idle");
        if (event.ok && event.testId) {
          toast.success(`Test #${event.testId} saved!`);
          refreshTests();
        }
        if (event.ok && event.selfHealed && event.selfHealed > 0) {
          toast.success(`Replay passed with ${event.selfHealed} healed step(s)!`);
        }
        if (!event.testId && !event.selfHealed && event.ok) {
          toast.success("Browse task completed!");
        }
        break;
      case "error":
        addStep({ label: "Fatal error", status: "failed", detail: event.message, timestamp: Date.now() });
        setStatus("error");
        setMode("idle");
        break;
    }
  }, [addStep, refreshTests]);

  const handleStartRecord = async () => {
    if (!query.trim()) return;
    setMode("recording");
    setStatus("running");
    setSteps([]);
    setMilestones([]);
    setCurrentMilestone(null);
    setRunResult(null);
    setScreenshot(null);

    let vars: Record<string, string> = {};
    try { vars = JSON.parse(variables); } catch { /* ignore malformed */ }

    abortRef.current = new AbortController();
    try {
      await startRecord(
        { query, entry_url: entryUrl, variables: vars, provider, model_id: modelId },
        { onEvent: handleEvent, signal: abortRef.current.signal },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recording failed");
      setStatus("error");
      setMode("idle");
    }
  };

  const handleStartReplay = async () => {
    if (selectedTest === null) return;
    const test = tests.find((t) => t.id === selectedTest);
    if (!test) return;

    setMode("replaying");
    setStatus("running");
    setSteps([]);
    setRunResult(null);
    setScreenshot(null);

    let vars: Record<string, string> = {};
    try { vars = JSON.parse(variables); } catch { /* ignore */ }

    // For heal demo: append ?redesign=1 to the entry URL
    const replayEntryUrl = redesign && test.entryUrl
      ? test.entryUrl + (test.entryUrl.includes("?") ? "&" : "?") + "redesign=1"
      : undefined;

    abortRef.current = new AbortController();
    try {
      await startReplay(
        { test_id: selectedTest, variables: vars, entry_url: replayEntryUrl, provider, model_id: modelId },
        { onEvent: handleEvent, signal: abortRef.current.signal },
      );
      // Refresh runs after replay
      listRuns(selectedTest).then((r) => setRuns(r.runs)).catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Replay failed");
      setStatus("error");
      setMode("idle");
    }
  };

  const handleStop = async () => {
    abortRef.current?.abort();
    try { await stopRun(); } catch { /* */ }
    setMode("idle");
    setStatus("idle");
  };

  const handleStartBrowse = async () => {
    if (!query.trim()) return;
    setMode("browsing");
    setStatus("running");
    setSteps([]);
    setMilestones([]);
    setCurrentMilestone(null);
    setRunResult(null);
    setScreenshot(null);

    abortRef.current = new AbortController();
    try {
      await startBrowse(
        { query, entry_url: entryUrl || undefined, provider, model_id: modelId },
        { onEvent: handleEvent, signal: abortRef.current.signal },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Browse failed");
      setStatus("error");
      setMode("idle");
    }
  };

  const handleDeleteTest = async (id: number) => {
    try {
      await deleteTest(id);
      toast.success(`Test #${id} deleted`);
      if (selectedTest === id) setSelectedTest(null);
      refreshTests();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleDeleteStep = async (testId: number, stepId: number) => {
    try {
      const result = await deleteStep(testId, stepId);
      setTests((prev) =>
        prev.map((t) =>
          t.id === testId
            ? { ...t, steps: result.steps, stepCount: result.steps.length }
            : t,
        ),
      );
      toast.success("Step removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove step");
    }
  };

  const running = mode !== "idle";
  const isRecording = mode === "recording";
  const isBrowsing = mode === "browsing";

  /** Colour class for the action type badge in the steps panel */
  const actionBadgeClass = (action: string) => {
    const map: Record<string, string> = {
      navigate: "bg-blue-500/10 text-blue-500",
      click: "bg-indigo-500/10 text-indigo-500",
      fill: "bg-green-600/10 text-green-600",
      select: "bg-amber-600/10 text-amber-600",
      scroll: "bg-slate-500/10 text-slate-500",
      assert: "bg-purple-500/10 text-purple-500",
      extract: "bg-teal-500/10 text-teal-500",
      wait: "bg-orange-500/10 text-orange-500",
      go_back: "bg-rose-500/10 text-rose-500",
    };
    return map[action] ?? "bg-zinc-500/10 text-zinc-500";
  };

  const quickSeeds = [
    { label: "Signup flow", query: "register a user on the signup page", url: "http://localhost:3123/signup" },
    { label: "Login flow", query: "log in with email and password", url: "http://localhost:3123/login" },
    { label: "Pricing waitlist", query: "join the pricing waitlist", url: "http://localhost:3123/pricing-waitlist" },
  ];

  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto px-4 py-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FlaskConical className="size-7 text-primary" />
              QueryFirst Demo
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Record natural-language tests, replay them with self-healing, or run the live agent on a browsing task.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {running && (
              <span className="flex items-center gap-1.5 text-primary animate-pulse">
                <Activity className="size-4" />
                {isRecording ? "Recording…" : isBrowsing ? "Browsing…" : "Replaying…"}
              </span>
            )}
            {status === "done" && !running && <span className="text-green-500 font-medium">Passed</span>}
            {status === "error" && !running && <span className="text-red-500 font-medium">Failed</span>}
          </div>
        </div>

        {/* Quick Seeds */}
        <div className="flex flex-wrap gap-2">
          {quickSeeds.map((seed) => (
            <Button
              key={seed.label}
 variant="outline"
              size="sm"
              disabled={running}
              onClick={() => { setQuery(seed.query); setEntryUrl(seed.url); }}
            >
              {seed.label}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr_360px] gap-4">
          {/* LEFT: Controls */}
          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Record a New Test</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label className="text-xs">Natural-language query</Label>
                  <Textarea value={query} onChange={(e) => setQuery(e.target.value)} rows={3} disabled={running} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Start URL</Label>
                  <Input value={entryUrl} onChange={(e) => setEntryUrl(e.target.value)} disabled={running} className="text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Variables (JSON)</Label>
                  <Input value={variables} onChange={(e) => setVariables(e.target.value)} disabled={running} className="text-sm font-mono" />
                </div>
                <Button onClick={handleStartRecord} disabled={running} className="w-full">
                  <Play className="size-4 mr-1.5" /> Record
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">LLM Model (for recording / healing)</CardTitle></CardHeader>
              <CardContent>
                <ModelSelector
                  provider={provider}
                  modelId={modelId}
                  onProviderChange={setProvider}
                  onModelIdChange={setModelId}
                  keys={keys}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-1.5"><Globe className="size-3.5" /> Live Browse Agent</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Run the AI agent directly on a browsing task. Unlike Record, it doesn't save a test — it just browses.
                </p>
                <Button onClick={handleStartBrowse} disabled={running} className="w-full" variant="secondary">
                  <Globe className="size-4 mr-1.5" /> Browse
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-sm">Replay & Heal</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label className="text-xs">Select a recorded test</Label>
                  {testsLoading ? (
                    <p className="text-xs text-muted-foreground">Loading…</p>
                  ) : tests.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No tests yet. Record one above.</p>
                  ) : (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {tests.map((t) => (
                        <div
                          key={t.id}
                          className={`flex items-center gap-2 p-1.5 rounded text-sm cursor-pointer border ${
                            selectedTest === t.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/50"
                          }`}
                          onClick={() => setSelectedTest(t.id)}
                        >
                          <span className="font-mono text-xs">#{t.id}</span>
                          <span className="flex-1 truncate">{t.name}</span>
                          <span className="text-xs text-muted-foreground">{t.stepCount} steps</span>
                          <Trash2
                            className="size-3.5 text-muted-foreground hover:text-red-500"
                            onClick={(e) => { e.stopPropagation(); handleDeleteTest(t.id); }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Collapsible steps panel — shown when a test is selected */}
                {selectedTest !== null && (() => {
                  const selTest = tests.find((t) => t.id === selectedTest);
                  if (!selTest || selTest.steps.length === 0) return null;
                  return (
                    <div>
                      <button
                        type="button"
                        className="w-full flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground py-0.5 transition-colors"
                        onClick={() => setStepsOpen((o) => !o)}
                      >
                        {stepsOpen
                          ? <ChevronDown className="size-3 shrink-0" />
                          : <ChevronRight className="size-3 shrink-0" />}
                        <span>Steps ({selTest.stepCount})</span>
                      </button>
                      {stepsOpen && (
                        <div className="mt-1 space-y-0.5 max-h-52 overflow-y-auto rounded border bg-muted/20 p-1">
                          {selTest.steps.map((step) => (
                            <div
                              key={step.id}
                              className="group flex items-center gap-1.5 px-1.5 py-1 rounded text-xs hover:bg-muted/60 transition-colors"
                            >
                              <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none ${actionBadgeClass(step.action)}`}>
                                {step.action}
                              </span>
                              <span className="flex-1 truncate text-foreground/80" title={step.intent}>
                                {step.intent}
                              </span>
                              {step.optional && (
                                <span className="shrink-0 rounded px-1 py-0.5 text-[10px] bg-zinc-500/10 text-zinc-400 leading-none">
                                  skippable
                                </span>
                              )}
                              <button
                                type="button"
                                disabled={selTest.stepCount <= 1 || running}
                                onClick={() => handleDeleteStep(selTest.id, step.id)}
                                title={selTest.stepCount <= 1 ? "Cannot delete the last step" : "Delete this step"}
                                className={`shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground ${
                                  selTest.stepCount <= 1 || running
                                    ? "cursor-not-allowed opacity-20 group-hover:opacity-20"
                                    : "hover:text-red-500"
                                }`}
                              >
                                <Trash2 className="size-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={redesign} onChange={(e) => setRedesign(e.target.checked)} disabled={running} />
                  <Wrench className="size-3.5" />
                  Break the UI (redesign) — triggers healing
                </label>
                <Button onClick={handleStartReplay} disabled={running || selectedTest === null} className="w-full" variant="secondary">
                  <RotateCcw className="size-4 mr-1.5" /> {redesign ? "Replay with Healing" : "Replay"}
                </Button>
                {selectedTest !== null && runs.length > 0 && (
                  <div className="text-xs text-muted-foreground space-y-0.5 max-h-24 overflow-y-auto">
                    {runs.slice(-5).reverse().map((r) => (
                      <div key={r.id} className="flex items-center gap-2">
                        <span className={`font-medium ${r.status === "passed" ? "text-green-500" : r.status === "failed" ? "text-red-500" : "text-muted-foreground"}`}>
                          {r.status}
                        </span>
                        <span>run #{r.id}</span>
                        <span className="text-muted-foreground">llm: {r.llmCalls}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {running && (
              <Button onClick={handleStop} variant="destructive" className="w-full">
                <Square className="size-4 mr-1.5" /> Stop
              </Button>
            )}
          </div>

          {/* CENTER: Live browser */}
          <div className="space-y-3">
            <Card className="overflow-hidden">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Camera className="size-4" /> Live Browser View
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="aspect-video w-full bg-zinc-900 rounded-lg flex items-center justify-center overflow-hidden border border-zinc-800">
                  {isValidScreenshot(screenshot) ? (
                    <img src={screenshot} alt="Browser" className="w-full h-full object-contain" />
                  ) : (
                    <span className="text-zinc-500 text-sm">
                      {running ? "Waiting for first screenshot…" : "No active run"}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>

            {milestones.length > 0 && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Milestones</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex items-center gap-1 text-sm flex-wrap">
                    {milestones.map((m, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <span className={`px-2 py-0.5 rounded ${currentMilestone === m ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                          {m}
                        </span>
                        {i < milestones.length - 1 && <span className="text-muted-foreground">→</span>}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {runResult && (
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      {runResult.ok ? (
                        <span className="text-green-500 font-medium flex items-center gap-1">
                          <Activity className="size-4" /> PASS
                        </span>
                      ) : (
                        <span className="text-red-500 font-medium">FAIL: {runResult.error}</span>
                      )}
                    </span>
                    {runResult.llmCalls !== undefined && (
                      <span className="text-muted-foreground">LLM calls: {runResult.llmCalls}</span>
                    )}
                    {runResult.selfHealed !== undefined && runResult.selfHealed > 0 && (
                      <span className="text-amber-500 font-medium">Healed: {runResult.selfHealed}</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* RIGHT: Activity log */}
          <div>
            <Card className="h-fit max-h-[calc(100dvh-120px)] overflow-hidden flex flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="size-4" /> Activity Log
                  {steps.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setSteps([])} className="ml-auto text-xs h-6">
                      Clear
                    </Button>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-y-auto flex-1 space-y-1">
                {steps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Activity will appear here.</p>
                ) : (
                  steps.map((step, i) => (
                    <div
                      key={i}
                      className={`text-xs p-1.5 rounded border-l-2 ${
                        step.status === "passed" ? "border-green-500 bg-green-500/5" :
                        step.status === "failed" ? "border-red-500 bg-red-500/5" :
                        step.status === "healed" ? "border-amber-500 bg-amber-500/5" :
                        step.status === "planned" ? "border-blue-500 bg-blue-500/5" :
                        "border-zinc-500 bg-zinc-500/5"
                      }`}
                    >
                      <div className="font-medium">{step.label}</div>
                      {step.detail && <div className="text-muted-foreground mt-0.5">{step.detail}</div>}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
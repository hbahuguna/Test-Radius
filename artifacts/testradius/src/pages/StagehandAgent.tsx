import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, ChevronRight, Code2, Loader2, Play, RefreshCcw, Sparkles, WandSparkles, Wrench } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector, defaultModelFor } from "@/components/tester/ModelSelector";
import {
  generateStagehandCode,
  runStagehandAgent,
  runStagehandScript,
  stopStagehandCodeRun,
  streamCodeRunEvents,
  repairStagehandScript,
  refineStagehandLocators,
  type StagehandLiveEvent,
  type StagehandRunResult,
} from "@/lib/stagehand-agent-api";
import { getBrowserAgentApiKeys, type UserApiKey } from "@/lib/browser-agent-api";
import { toast } from "sonner";

interface CodeStepLog {
  id: string;
  [key: string]: unknown;
}

export function StagehandAgent() {
  const [url, setUrl] = useState("https://example.com");
  const [goal, setGoal] = useState("Click the Learn more link and report the destination URL");
  const [provider, setProvider] = useState("opencode");
  const [model, setModel] = useState(defaultModelFor("opencode"));
  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [maxSteps, setMaxSteps] = useState("10");
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [run, setRun] = useState<StagehandRunResult | null>(null);
  const [code, setCode] = useState("");
  const [liveEvents, setLiveEvents] = useState<StagehandLiveEvent[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);

  // Script execution
  const [codeRunId, setCodeRunId] = useState<string | null>(null);
  const [codeLogs, setCodeLogs] = useState<CodeStepLog[]>([]);
  const [runningScript, setRunningScript] = useState(false);
  const [runScreenshot, setRunScreenshot] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Repair / refine
  const [repairError, setRepairError] = useState("");
  const [repairing, setRepairing] = useState(false);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refining, setRefining] = useState(false);
  const [locators, setLocators] = useState<Array<{ selector?: string; description?: string; method?: string }>>([]);

  useEffect(() => {
    getBrowserAgentApiKeys().then(setKeys).catch(() => {});
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const handleRun = async () => {
    if (!url.trim() || !goal.trim()) return;
    setRunning(true);
    setRun(null);
    setCode("");
    setLiveEvents([]);
    setScreenshot(null);
    setLocators([]);
    setCodeLogs([]);
    setCodeRunId(null);
    setRunScreenshot(null);
    try {
      const result = await runStagehandAgent({
        url: url.trim(),
        goal: goal.trim(),
        model_provider: provider,
        model_id: model,
        max_steps: Math.max(1, Math.min(Number(maxSteps) || 10, 30)),
      }, (event) => {
        setLiveEvents((previous) => [...previous, event]);
        if (event.event === "step" && event.screenshot) setScreenshot(event.screenshot);
        if (event.event === "loading" && event.screenshot) setScreenshot(event.screenshot);
      });
      setRun(result);
      setCode(result.code);
      if (result.status === "completed") toast.success("Stagehand run completed");
      else toast.error(result.result.message || "Stagehand could not verify the requested goal");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Stagehand run failed");
    } finally {
      setRunning(false);
    }
  };

  const handleGenerate = async () => {
    if (!run || generating) return;
    setGenerating(true);
    try {
      const result = await generateStagehandCode(run.runId);
      setRun((current) => current ? { ...current, ...result, trace: current.trace, scriptId: result.scriptId ?? current.scriptId } : result);
      setCode(result.code);
      toast.success("Playwright code generated from Stagehand actions");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Code generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleRunScript = async () => {
    const scriptId = run?.scriptId;
    if (!url.trim() || !scriptId || runningScript) return;
    setRunningScript(true);
    setCodeLogs([]);
    setRunScreenshot(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { codeRunId } = await runStagehandScript(scriptId, url.trim());
      setCodeRunId(codeRunId);
      await streamCodeRunEvents(codeRunId, (event) => {
        setCodeLogs((previous) => [...previous, { id: crypto.randomUUID(), ...event }]);
        if (event.event === "screenshot" && typeof event.screenshot === "string") setRunScreenshot(event.screenshot);
      }, controller.signal);
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") toast.error(error instanceof Error ? error.message : "Script run failed");
    } finally {
      setRunningScript(false);
      abortRef.current = null;
    }
  };

  const handleStopScript = async () => {
    if (codeRunId) await stopStagehandCodeRun(codeRunId);
    abortRef.current?.abort();
    setRunningScript(false);
  };

  const handleRepair = async () => {
    const scriptId = run?.scriptId;
    if (!scriptId || repairing) return;
    setRepairing(true);
    try {
      const result = await repairStagehandScript(scriptId, repairError.trim());
      setCode(result.code);
      setRun((current) => current ? { ...current, code: result.code, warnings: result.warnings } : current);
      toast.success(result.explanation || "Script repaired from the source trace");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Repair failed");
    } finally {
      setRepairing(false);
    }
  };

  const handleRefine = async () => {
    const scriptId = run?.scriptId;
    if (!scriptId || refining) return;
    setRefining(true);
    try {
      const result = await refineStagehandLocators(scriptId, refineInstruction);
      setLocators(result.locators);
      toast.success(`Refined ${result.locators.length} locators`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Locator refinement failed");
    } finally {
      setRefining(false);
    }
  };

  const actionCount = run?.trace.reduce((count, step) => count + step.actions.length, 0) ?? 0;
  const liveActions: Array<Extract<StagehandLiveEvent, { event: "step" }>> = liveEvents.filter(
    (event): event is Extract<StagehandLiveEvent, { event: "step" }> => event.event === "step" && event.stepNumber > 0,
  );

  return (
    <Layout>
      <main className="min-h-[calc(100dvh-80px)] bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/.12),transparent_38%),linear-gradient(135deg,hsl(var(--background)),hsl(var(--muted)/.45))] px-4 py-10 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary"><WandSparkles className="h-4 w-4" /> Primary engine</div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">Stagehand Agent</h1>
              <p className="mt-3 max-w-2xl text-base text-muted-foreground sm:text-lg">Run a browser workflow through Stagehand, watch its recorded actions, and generate locator-based Playwright code you can run, repair, or refine.</p>
            </div>
            <Link href="/browser-auto" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">Legacy engines <ChevronRight className="h-4 w-4" /></Link>
          </div>

          <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
            <Card className="h-fit border-primary/15 bg-card/90 shadow-xl backdrop-blur">
              <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /> Workflow</CardTitle></CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2"><Label htmlFor="sh-url">Starting URL</Label><Input id="sh-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" /></div>
                <div className="space-y-2"><Label htmlFor="sh-goal">Goal</Label><Textarea id="sh-goal" value={goal} onChange={(event) => setGoal(event.target.value)} className="min-h-28 resize-y" placeholder="e.g. Find the cheapest flight from NYC to London" /></div>
                <ModelSelector provider={provider} modelId={model} onProviderChange={(next) => { setProvider(next); setModel(defaultModelFor(next)); }} onModelIdChange={setModel} keys={keys} />
                <div className="space-y-2"><Label htmlFor="sh-steps">Maximum steps</Label><Input id="sh-steps" type="number" min={1} max={30} value={maxSteps} onChange={(event) => setMaxSteps(event.target.value)} /></div>
                <Button className="w-full" onClick={handleRun} disabled={running || !url.trim() || !goal.trim()}>{running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Running Stagehand</> : <><Play className="mr-2 h-4 w-4" />Run Stagehand Agent</>}</Button>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur">
                <CardHeader><CardTitle className="flex items-center gap-2"><Play className="h-5 w-5 text-primary" /> Live browser</CardTitle></CardHeader>
                <CardContent>
<div className="aspect-video overflow-hidden rounded-xl border border-border bg-white">
                    {screenshot ? <img src={screenshot} alt="Live Stagehand browser state" className="h-full w-full object-contain" /> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{running ? "Launching browser…" : "Browser preview appears during a run"}</div>}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur">
                <CardHeader><CardTitle className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Recorded actions</span>{run && <span className="text-sm font-normal text-muted-foreground">{actionCount} actions</span>}</CardTitle></CardHeader>
                <CardContent>
                  {liveActions.length === 0 && actionCount === 0 && !run ? <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground"><Sparkles className="mb-3 h-8 w-8 text-primary/60" /><p>Run a workflow to inspect the actions Stagehand actually performed.</p></div> : <div className="space-y-3">{liveActions.length > 0 ? liveActions.map((event, index) => <div key={`${event.stepNumber}-${index}`} className="rounded-xl border border-border/80 bg-muted/30 p-4"><div className="mb-1 flex items-center justify-between text-xs font-medium uppercase tracking-wider text-primary"><span>Step {event.stepNumber}</span>{event.url && <span className="max-w-[60%] truncate text-muted-foreground normal-case tracking-normal">{event.url}</span>}</div>{event.actions.map((action, i) => <div key={i} className="mt-1 text-sm"><span className="mr-2 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs">{String(action.name ?? action.type ?? action.action ?? "action")}</span>{String(action.input ?? action.description ?? "")}</div>)}</div>) : null}{run && actionCount > 0 && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{actionCount} recorded actions are ready for code generation.</div>}</div>}
                </CardContent>
              </Card>

              {run && <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2"><Code2 className="h-5 w-5 text-primary" /> Playwright output</span>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" onClick={handleRunScript} disabled={runningScript || !run.scriptId}>{runningScript ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Play className="mr-1 h-4 w-4" />}{runningScript ? "Running" : "Run"}</Button>
                      {runningScript && codeRunId && <Button size="sm" variant="destructive" onClick={handleStopScript}>Stop</Button>}
                      <Button size="sm" variant="outline" onClick={handleGenerate} disabled={generating}>{generating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-1 h-4 w-4" />}Regenerate</Button>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} className="min-h-[420px] resize-y bg-zinc-950 p-4 font-mono text-sm text-zinc-100" aria-label="Stagehand generated Playwright code" />
                  {run.warnings.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{run.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
                  {run.output && Object.keys(run.output).length > 0 && <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm"><span className="font-medium">Extracted result</span><pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-muted-foreground">{JSON.stringify(run.output, null, 2)}</pre></div>}
                </CardContent>
              </Card>}

              {(codeLogs.length > 0 || runScreenshot) && (
                <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur">
                  <CardHeader><CardTitle className="flex items-center gap-2"><Code2 className="h-5 w-5 text-primary" /> Script run</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {runScreenshot && <div className="aspect-video overflow-hidden rounded-xl border border-border bg-zinc-950"><img src={runScreenshot} alt="Script step" className="h-full w-full object-contain" /></div>}
                    <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs">
                      {codeLogs.map((log) => {
                        const name = String(log.name ?? "");
                        const url = String(log.url ?? "");
                        const message = String(log.message ?? "");
                        const error = String(log.error ?? "");
                        const success = log.success as boolean | undefined;
                        const level = String(log.level ?? "");
                        if (log.event === "code_step_started") return <p key={log.id} className="text-sky-300">▸ {name}</p>;
                        if (log.event === "code_step_completed") return <p key={log.id} className="text-emerald-400">✓ {name} ({url})</p>;
                        if (log.event === "code_step_failed") return <p key={log.id} className="text-red-400">✗ {name}: {error}</p>;
                        if (log.event === "code_run_completed") return <p key={log.id} className={success === false ? "text-red-400" : "text-emerald-400"}>{success ? "Run completed" : `Run failed: ${error}`} {url ? `· ${url}` : ""}</p>;
                        if (log.event === "code_run_stopped") return <p key={log.id} className="text-amber-400">Run stopped</p>;
                        if (log.event === "console") return <p key={log.id} className={level === "error" ? "text-red-400" : "text-zinc-400"}>{message}</p>;
                        return <p key={log.id} className="text-zinc-500">{JSON.stringify(log)}</p>;
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {run && (
                <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur">
                  <CardHeader><CardTitle className="flex items-center gap-2"><Wrench className="h-5 w-5 text-primary" /> Repair &amp; refine</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="sh-repair">Runtime error (paste from a failed run)</Label>
                      <div className="flex gap-2">
                        <Input id="sh-repair" value={repairError} onChange={(event) => setRepairError(event.target.value)} placeholder="TimeoutError: …" />
                        <Button size="sm" onClick={handleRepair} disabled={repairing || !run.scriptId}>{repairing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wrench className="mr-1 h-4 w-4" />}{repairing ? "Repairing" : "Repair"}</Button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="run-refine">Locator refinement instruction</Label>
                      <div className="flex gap-2">
                        <Input id="run-refine" value={refineInstruction} onChange={(event) => setRefineInstruction(event.target.value)} placeholder="Find robust locators for the date picker" />
                        <Button size="sm" onClick={handleRefine} disabled={refining || !run.scriptId}>{refining ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}{refining ? "Refining" : "Refine"}</Button>
                      </div>
                    </div>
                    {locators.length > 0 && <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm"><span className="font-medium">Suggested locators</span><ul className="mt-2 space-y-1 font-mono text-xs">{locators.map((l, index) => <li key={index} className="truncate"><span className="text-primary">{l.method}</span> · {l.selector} — {l.description}</li>)}</ul></div>}
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}
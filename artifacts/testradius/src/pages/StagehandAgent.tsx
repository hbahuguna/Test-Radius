import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CheckCircle2, ChevronRight, Code2, Loader2, Play, Sparkles, WandSparkles } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ModelSelector, defaultModelFor } from "@/components/tester/ModelSelector";
import { generateStagehandCode, runStagehandAgent, type StagehandLiveEvent, type StagehandRunResult } from "@/lib/stagehand-agent-api";
import { getBrowserAgentApiKeys, type UserApiKey } from "@/lib/browser-agent-api";
import { toast } from "sonner";

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

  useEffect(() => {
    getBrowserAgentApiKeys().then(setKeys).catch(() => {});
  }, []);

  const handleRun = async () => {
    if (!url.trim() || !goal.trim()) return;
    setRunning(true);
    setRun(null);
    setCode("");
    setLiveEvents([]);
    setScreenshot(null);
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
      setRun((current) => current ? { ...current, ...result, trace: current.trace } : result);
      setCode(result.code);
      toast.success("Playwright code generated from Stagehand actions");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Code generation failed");
    } finally {
      setGenerating(false);
    }
  };

  const actionCount = run?.trace.reduce((count, step) => count + step.actions.length, 0) ?? 0;

  return (
    <Layout>
      <main className="min-h-[calc(100dvh-80px)] bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/.12),transparent_38%),linear-gradient(135deg,hsl(var(--background)),hsl(var(--muted)/.45))] px-4 py-10 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-primary"><WandSparkles className="h-4 w-4" /> Experimental engine</div>
              <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">Stagehand Agent</h1>
              <p className="mt-3 max-w-2xl text-base text-muted-foreground sm:text-lg">Run the same browser workflow through Stagehand, inspect its recorded actions, and compare the generated Playwright output with Browser Agent.</p>
            </div>
            <Link href="/browser-agent" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">Compare with Browser Agent <ChevronRight className="h-4 w-4" /></Link>
          </div>

          <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
            <Card className="h-fit border-primary/15 bg-card/90 shadow-xl backdrop-blur">
              <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /> Workflow</CardTitle></CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2"><Label htmlFor="stagehand-url">Starting URL</Label><Input id="stagehand-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" /></div>
                <div className="space-y-2"><Label htmlFor="stagehand-goal">Goal</Label><Textarea id="stagehand-goal" value={goal} onChange={(event) => setGoal(event.target.value)} className="min-h-28 resize-y" placeholder="Describe the workflow Stagehand should perform" /></div>
                <ModelSelector provider={provider} modelId={model} onProviderChange={(next) => { setProvider(next); setModel(defaultModelFor(next)); }} onModelIdChange={setModel} keys={keys} />
                <div className="space-y-2"><Label htmlFor="stagehand-steps">Maximum steps</Label><Input id="stagehand-steps" type="number" min={1} max={30} value={maxSteps} onChange={(event) => setMaxSteps(event.target.value)} /></div>
                <Button className="w-full" onClick={handleRun} disabled={running || !url.trim() || !goal.trim()}>{running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Running Stagehand</> : <><Play className="mr-2 h-4 w-4" />Run Stagehand Agent</>}</Button>
                <p className="text-xs leading-relaxed text-muted-foreground">Stagehand streams browser screenshots and step updates while it works. Its action history is stored separately from browser-use.</p>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur">
                <CardHeader><CardTitle className="flex items-center gap-2"><Play className="h-5 w-5 text-primary" /> Live browser</CardTitle></CardHeader>
                <CardContent>
                  <div className="aspect-video overflow-hidden rounded-xl border border-border bg-zinc-950">
                    {screenshot ? <img src={screenshot} alt="Live Stagehand browser state" className="h-full w-full object-contain" /> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{running ? "Launching browser…" : "Browser preview appears during a run"}</div>}
                  </div>
                </CardContent>
              </Card>

              <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur">
                <CardHeader><CardTitle className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-emerald-500" /> Recorded actions</span>{run && <span className="text-sm font-normal text-muted-foreground">{actionCount} actions</span>}</CardTitle></CardHeader>
                <CardContent>
                  {liveEvents.length === 0 && !run ? <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground"><Sparkles className="mb-3 h-8 w-8 text-primary/60" /><p>Run a workflow to inspect Stagehand’s live action history.</p></div> : <div className="space-y-3">{liveEvents.filter((event) => event.event === "step" && (event.stepNumber > 0 || event.actions.length > 0)).map((event, index) => event.event === "step" && <div key={`${event.stepNumber}-${index}`} className="rounded-xl border border-border/80 bg-muted/30 p-4"><div className="mb-1 text-xs font-medium uppercase tracking-wider text-primary">Step {event.stepNumber}</div><div className="font-medium">{event.actions.length > 0 ? event.actions.map((action) => String(action.name ?? action.action ?? action.type ?? "action")).join(", ") : event.text || "Stagehand processed the page"}</div>{event.url && <code className="mt-2 block break-all text-xs text-muted-foreground">{event.url}</code>}</div>)}{run && run.trace.flatMap((step) => step.actions).length > 0 && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{actionCount} recorded actions are ready for code generation.</div>}</div>}
                </CardContent>
              </Card>

              {run && <Card className="border-primary/15 bg-card/90 shadow-xl backdrop-blur"><CardHeader><CardTitle className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><Code2 className="h-5 w-5 text-primary" /> Playwright output</span><Button size="sm" variant="outline" onClick={handleGenerate} disabled={generating}>{generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Code2 className="mr-2 h-4 w-4" />}{generating ? "Generating" : "Regenerate from trace"}</Button></CardTitle></CardHeader><CardContent className="space-y-3"><Textarea value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} className="min-h-[520px] resize-y bg-zinc-950 p-4 font-mono text-sm text-zinc-100" aria-label="Stagehand generated Playwright code" />{run.warnings.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{run.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}</CardContent></Card>}
            </div>
          </div>
        </div>
      </main>
    </Layout>
  );
}

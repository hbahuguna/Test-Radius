import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { getTestRun, type QfRunStepDetail, type QfScreenshotRef, type QfTestRunDetail } from "@/lib/queryfirst-api";
import { Camera } from "lucide-react";
import { RunStatusBadge } from "./RunStatusBadge";
import { fmtDuration, fmtTime } from "./format";

export function TestRunDetail({ runId }: { runId: number }) {
  const [run, setRun] = useState<QfTestRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openShot, setOpenShot] = useState<QfScreenshotRef | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTestRun(runId)
      .then((r) => {
        if (!cancelled) setRun(r.run);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load test run");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (error || !run) return <p className="text-xs text-red-500">{error ?? "Test run not found"}</p>;

  const screenshotForStep = (idx: number) => {
    const prefix = `${run.runId}-${String(idx + 1).padStart(2, "0")}-`;
    return run.screenshots.find((s) => s.path.startsWith(prefix));
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="truncate">{run.testName}</span>
            <RunStatusBadge status={run.status} />
            <span className="text-muted-foreground font-normal">run #{run.runId}</span>
            {run.suiteRunId !== null && (
              <span className="text-muted-foreground font-normal shrink-0">suite run #{run.suiteRunId}</span>
            )}
            <span className="text-muted-foreground font-normal ml-auto shrink-0 text-xs">
              {fmtTime(run.startedAt)} → {fmtTime(run.finishedAt)} ({fmtDuration(run.startedAt, run.finishedAt)})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>LLM calls: {run.llmCalls}</span>
            {run.screenshots.length > 0 && (
              <span className="flex items-center gap-1">
                <Camera className="size-3" /> {run.screenshots.length} screenshot(s)
              </span>
            )}
          </div>
          {run.error && (
            <div className="text-xs text-red-500 rounded border border-red-500/30 bg-red-500/5 p-2 break-words">
              {run.error}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Steps ({run.steps.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {run.steps.length === 0 ? (
            <p className="text-xs text-muted-foreground">No steps recorded for this run.</p>
          ) : (
            run.steps.map((s) => {
              const shot = screenshotForStep(s.idx);
              return (
                <div key={s.idx} className="flex items-start gap-2 py-1">
                  <RunStatusBadge status={s.status} />
                  <span className="font-mono text-muted-foreground text-xs mt-0.5 shrink-0">#{s.idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs truncate">{s.intent ?? ""}</p>
                    <StepDetail detail={s.detail} />
                  </div>
                  {shot && (
                    <button
                      onClick={() => setOpenShot(shot)}
                      className="shrink-0 w-16 aspect-video rounded border border-zinc-800 overflow-hidden bg-zinc-900 hover:border-primary transition-colors"
                      title={shot.path}
                    >
                      <img src={shot.url} alt={shot.path} className="w-full h-full object-cover" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {run.screenshots.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Camera className="size-3.5" /> Screenshots — click to view
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 md:grid-cols-4 gap-1.5">
              {run.screenshots.map((s) => (
                <button
                  key={s.path}
                  onClick={() => setOpenShot(s)}
                  className="aspect-video rounded border border-zinc-800 overflow-hidden bg-zinc-900 hover:border-primary transition-colors"
                  title={s.path}
                >
                  <img src={s.url} alt={s.path} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={openShot !== null} onOpenChange={(o) => { if (!o) setOpenShot(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono">{openShot?.path}</DialogTitle>
          </DialogHeader>
          {openShot && <img src={openShot.url} alt={openShot.path} className="w-full rounded border border-zinc-800" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepDetail({ detail }: { detail: QfRunStepDetail["detail"] }) {
  if (!detail) return null;
  const error = detail.error;
  const healed = detail.healed;
  const reason = detail.reason;
  const selector = detail.selector;
  if (typeof error === "string") {
    return <p className="text-xs text-red-500 break-words">{error}</p>;
  }
  if (typeof healed === "string") {
    return <p className="text-xs text-amber-500 break-words">Healed → {healed}</p>;
  }
  if (typeof reason === "string") {
    return <p className="text-xs text-muted-foreground">{reason}</p>;
  }
  if (typeof selector === "string") {
    return <p className="text-xs text-muted-foreground font-mono truncate">{selector}</p>;
  }
  if (typeof detail.method === "string" && typeof detail.path === "string") {
    const parts = [detail.method, detail.path];
    if (typeof detail.status === "number" && typeof detail.expected === "number") {
      parts.push(`→ ${detail.status} (expected ${detail.expected})`);
    }
    if (typeof detail.duration === "number") {
      parts.push(`[${detail.duration}ms]`);
    }
    return (
      <>
        <p className="text-xs text-muted-foreground font-mono truncate">{parts.join(" ")}</p>
        {typeof detail.requestBody === "string" && detail.requestBody && (
          <div className="mt-1">
            <span className="text-xs text-muted-foreground">Request body:</span>
            <pre className="text-xs text-foreground/90 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">{(() => { try { return JSON.stringify(JSON.parse(detail.requestBody as string), null, 2); } catch { return detail.requestBody; } })()}</pre>
          </div>
        )}
        {typeof detail.responseBody === "string" && detail.responseBody && (
          <div className="mt-1">
            <span className="text-xs text-muted-foreground">Response ({String(detail.status)}):</span>
            <pre className="text-xs text-foreground/90 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{(() => { try { return JSON.stringify(JSON.parse(detail.responseBody as string), null, 2); } catch { return detail.responseBody; } })()}</pre>
          </div>
        )}
      </>
    );
  }
  return null;
}

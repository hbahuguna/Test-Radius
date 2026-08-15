import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getSuiteRun, type QfSuiteRun } from "@/lib/queryfirst-api";
import { RunStatusBadge } from "./RunStatusBadge";
import { fmtDuration, fmtTime } from "./format";

export function SuiteRunDetailView({
  suiteRunId,
  onOpenTest,
}: {
  suiteRunId: number;
  onOpenTest: (runId: number) => void;
}) {
  const [suiteRun, setSuiteRun] = useState<QfSuiteRun | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getSuiteRun(suiteRunId)
      .then((r) => {
        if (!cancelled) setSuiteRun(r.suiteRun);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [suiteRunId]);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (!suiteRun) return <p className="text-xs text-red-500">Suite run not found.</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <RunStatusBadge status={suiteRun.status} />
        <span className="font-medium text-sm text-foreground">{suiteRun.suiteName}</span>
        <span className="font-mono">run #{suiteRun.id}</span>
        {suiteRun.trainRunId !== null && <span>from train run #{suiteRun.trainRunId}</span>}
        <span className="ml-auto">{fmtTime(suiteRun.startedAt)} → {fmtTime(suiteRun.finishedAt)} ({fmtDuration(suiteRun.startedAt, suiteRun.finishedAt)})</span>
      </div>

      {typeof suiteRun.error === "string" && suiteRun.error && (
        <div className="text-xs text-red-500 rounded border border-red-500/30 bg-red-500/5 p-2 break-words">
          {suiteRun.error}
        </div>
      )}

      <div className="space-y-2">
        {suiteRun.runs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No member test runs recorded.</p>
        ) : (
          suiteRun.runs.map((r) => (
            <button
              key={r.runId}
              onClick={() => onOpenTest(r.runId)}
              className="w-full text-left rounded-lg border border-zinc-800 bg-card p-2.5 hover:border-primary transition-colors"
            >
              <div className="flex items-center gap-2 text-xs">
                <RunStatusBadge status={r.status} />
                <span className="flex-1 truncate font-medium">{r.name || `Test #${r.testId}`}</span>
                <span className="text-muted-foreground font-mono">run #{r.runId}</span>
                <span className="text-muted-foreground">
                  {fmtTime(r.startedAt)} ({fmtDuration(r.startedAt, r.finishedAt)})
                </span>
              </div>
              {r.error && <p className="text-xs text-red-500 truncate mt-1" title={r.error}>{r.error}</p>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

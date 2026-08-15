import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTrainRunSuites, listTrainRunsPage, type QfTrainRunSummary } from "@/lib/queryfirst-api";
import { RefreshCw } from "lucide-react";
import { PagedRunList } from "./PagedRunList";
import { RunningBanner } from "./RunningBanner";
import { RunStatusBadge } from "./RunStatusBadge";
import { fmtDuration, fmtTime } from "./format";
import { SuiteRunDetailView } from "./SuiteRunDetailView";
import { TestRunDetail } from "./TestRunDetail";
import { DetailLayout } from "./DetailLayout";

const PAGE_SIZE = 10;

type View =
  | { kind: "list" }
  | { kind: "trainRun"; trainRunId: number }
  | { kind: "suiteRun"; suiteRunId: number }
  | { kind: "testRun"; runId: number };

export function TrainRunsReport() {
  const [stack, setStack] = useState<View[]>([{ kind: "list" }]);
  const current = stack[stack.length - 1];
  const push = (v: View) => setStack((s) => [...s, v]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  if (current.kind === "list") {
    return <TrainRunList onOpenTrainRun={(id) => push({ kind: "trainRun", trainRunId: id })} />;
  }
  if (current.kind === "trainRun") {
    return (
      <DetailLayout title={`Train run #${current.trainRunId}`} onBack={pop}>
        <TrainRunDetailView
          trainRunId={current.trainRunId}
          onOpenSuite={(suiteRunId) => push({ kind: "suiteRun", suiteRunId })}
        />
      </DetailLayout>
    );
  }
  if (current.kind === "suiteRun") {
    return (
      <DetailLayout title={`Suite run #${current.suiteRunId}`} onBack={pop}>
        <SuiteRunDetailView
          suiteRunId={current.suiteRunId}
          onOpenTest={(runId) => push({ kind: "testRun", runId })}
        />
      </DetailLayout>
    );
  }
  return (
    <DetailLayout title={`Test run #${current.runId}`} onBack={pop}>
      <TestRunDetail runId={current.runId} />
    </DetailLayout>
  );
}

function TrainRunList({ onOpenTrainRun }: { onOpenTrainRun: (trainRunId: number) => void }) {
  const [runs, setRuns] = useState<QfTrainRunSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    try {
      const res = await listTrainRunsPage({ limit: PAGE_SIZE, offset });
      setRuns((prev) => (append ? [...prev, ...res.runs] : res.runs));
      setHasMore(res.hasMore);
    } catch {
      /* keep stale data */
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadPage(0, false);
  }, [loadPage]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          Train Runs
          <span className="text-muted-foreground font-normal">(newest first)</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-xs h-6"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              loadPage(0, false);
            }}
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <RunningBanner
          onFinished={() => {
            setLoading(true);
            loadPage(0, false);
          }}
        />
        <PagedRunList
          rows={runs}
          hasMore={hasMore}
          loading={loadingMore}
          onLoadMore={() => {
            setLoadingMore(true);
            loadPage(runs.length, true);
          }}
          rowKey={(r) => r.id}
          emptyText="No train runs yet — run a train from the Trains tab."
          renderRow={(r) => (
            <button
              onClick={() => onOpenTrainRun(r.id)}
              className="w-full text-left rounded-lg border border-zinc-800 bg-card p-2.5 hover:border-primary transition-colors"
            >
              <div className="flex items-center gap-2 text-xs">
                <RunStatusBadge status={r.status} />
                <span className="flex-1 truncate font-medium">{r.trainName}</span>
                <span className="text-muted-foreground font-mono">#{r.id}</span>
                <span className="text-muted-foreground shrink-0">{fmtTime(r.startedAt)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1 pl-1">
                {r.suiteCount} suite(s) · {fmtDuration(r.startedAt, r.finishedAt)} · mode {r.mode}
              </div>
            </button>
          )}
        />
      </CardContent>
    </Card>
  );
}

function TrainRunDetailView({
  trainRunId,
  onOpenSuite,
}: {
  trainRunId: number;
  onOpenSuite: (suiteRunId: number) => void;
}) {
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof getTrainRunSuites>>["suiteRuns"]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTrainRunSuites(trainRunId)
      .then((r) => {
        if (!cancelled) setRuns(r.suiteRuns);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trainRunId]);

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="h-6 rounded bg-muted animate-pulse" />
        <div className="h-32 rounded bg-muted animate-pulse" />
      </div>
    );
  }
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No suite runs recorded for this train run.</p>;
  }

  return (
    <div className="space-y-2">
      {runs.map((r) => (
        <button
          key={r.id}
          onClick={() => onOpenSuite(r.id)}
          className="w-full text-left rounded-lg border border-zinc-800 bg-card p-2.5 hover:border-primary transition-colors"
        >
          <div className="flex items-center gap-2 text-xs">
            <RunStatusBadge status={r.status} />
            <span className="flex-1 truncate font-medium">{r.suiteName}</span>
            <span className="text-muted-foreground font-mono">#{r.id}</span>
            <span className="text-muted-foreground shrink-0">
              {fmtTime(r.startedAt)} ({fmtDuration(r.startedAt, r.finishedAt)})
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-1 pl-1">
            {r.testCount} test(s) · {r.passed} passed · {r.failed} failed · mode {r.mode}
          </div>
        </button>
      ))}
    </div>
  );
}

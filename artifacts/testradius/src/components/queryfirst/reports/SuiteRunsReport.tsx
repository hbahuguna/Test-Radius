import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listSuiteRunsPage, type QfSuiteRunSummary } from "@/lib/queryfirst-api";
import { RefreshCw } from "lucide-react";
import { PagedRunList } from "./PagedRunList";
import { RunStatusBadge } from "./RunStatusBadge";
import { fmtDuration, fmtTime } from "./format";
import { SuiteRunDetailView } from "./SuiteRunDetailView";
import { TestRunDetail } from "./TestRunDetail";
import { DetailLayout } from "./DetailLayout";

const PAGE_SIZE = 10;

type View =
  | { kind: "list" }
  | { kind: "suiteRun"; suiteRunId: number }
  | { kind: "testRun"; runId: number };

export function SuiteRunsReport() {
  const [stack, setStack] = useState<View[]>([{ kind: "list" }]);
  const current = stack[stack.length - 1];
  const push = (v: View) => setStack((s) => [...s, v]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  if (current.kind === "list") {
    return <SuiteRunList onOpenSuite={(id) => push({ kind: "suiteRun", suiteRunId: id })} />;
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

function SuiteRunList({ onOpenSuite }: { onOpenSuite: (suiteRunId: number) => void }) {
  const [runs, setRuns] = useState<QfSuiteRunSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    try {
      const res = await listSuiteRunsPage({ limit: PAGE_SIZE, offset });
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
          Test Suite Runs
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
      <CardContent>
        <PagedRunList
          rows={runs}
          hasMore={hasMore}
          loading={loadingMore}
          onLoadMore={() => {
            setLoadingMore(true);
            loadPage(runs.length, true);
          }}
          rowKey={(r) => r.id}
          emptyText="No suite runs yet — run a suite from the Suites tab."
          renderRow={(r) => (
            <button
              onClick={() => onOpenSuite(r.id)}
              className="w-full text-left rounded-lg border border-zinc-800 bg-card p-2.5 hover:border-primary transition-colors"
            >
              <div className="flex items-center gap-2 text-xs">
                <RunStatusBadge status={r.status} />
                <span className="flex-1 truncate font-medium">{r.suiteName}</span>
                {r.trainRunId !== null && (
                  <Badge variant="outline" className="text-[10px] h-4">from train #{r.trainRunId}</Badge>
                )}
                <span className="text-muted-foreground font-mono">#{r.id}</span>
                <span className="text-muted-foreground shrink-0">{fmtTime(r.startedAt)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1 pl-1">
                {r.testCount} test(s) · {r.passed} passed · {r.failed} failed ·{" "}
                {fmtDuration(r.startedAt, r.finishedAt)} · mode {r.mode}
              </div>
            </button>
          )}
        />
      </CardContent>
    </Card>
  );
}

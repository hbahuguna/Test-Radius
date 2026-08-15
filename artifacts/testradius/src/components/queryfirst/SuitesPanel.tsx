import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  createSuite,
  deleteSuite,
  getSuiteRun,
  listSuiteRuns,
  listSuites,
  listTests,
  startSuiteRun,
  updateSuiteTests,
  type QfEvent,
  type QfMode,
  type QfSuite,
  type QfSuiteMember,
  type QfSuiteRun,
  type QfTest,
} from "@/lib/queryfirst-api";
import { toast } from "sonner";
import { Play, Plus, RefreshCw, Square, Trash2, Settings2 } from "lucide-react";
import { SuiteRunCard } from "./SuiteRunCard";
import { BucketsEditor, type BucketItem, type BucketMember } from "./BucketsEditor";

interface LogLine {
  label: string;
  status: "passed" | "failed" | "skipped" | "info";
}

interface RecentRun {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

function ModeBadge({ mode }: { mode: QfMode }) {
  const color =
    mode === "parallel"
      ? "border-blue-500/40 text-blue-400"
      : mode === "mixed"
        ? "border-purple-500/40 text-purple-400"
        : "";
  return <Badge variant="outline" className={color}>{mode}</Badge>;
}

export function SuitesPanel() {
  const [suites, setSuites] = useState<QfSuite[]>([]);
  const [tests, setTests] = useState<QfTest[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<BucketMember[]>([]);
  const [creating, setCreating] = useState(false);

  const [editingSuite, setEditingSuite] = useState<number | null>(null);
  const [editMembers, setEditMembers] = useState<BucketMember[]>([]);
  const [savingMembers, setSavingMembers] = useState(false);

  const [runningSuite, setRunningSuite] = useState<number | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [runDetails, setRunDetails] = useState<Record<number, QfSuiteRun>>({});
  const [recentRuns, setRecentRuns] = useState<Record<number, RecentRun[]>>({});
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([listSuites(), listTests()]);
      setSuites(s.suites);
      setTests(t.tests);
    } catch {
      /* keep stale data */
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    return () => { abortRef.current?.abort(); };
  }, [refresh]);

  const allTestItems: BucketItem[] = tests.map((t) => ({
    id: t.id,
    label: t.name,
    sublabel: `#${t.id}`,
  }));

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const suiteMembers: QfSuiteMember[] = members.map((m) => ({ testId: m.id, parallel: m.parallel }));
      const { suite } = await createSuite({ name: name.trim(), tests: suiteMembers });
      toast.success(`Suite "${suite.name}" created`);
      setName("");
      setMembers([]);
      setShowCreate(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create suite");
    } finally {
      setCreating(false);
    }
  };

  const handleStartEdit = (suite: QfSuite) => {
    setEditingSuite(suite.id);
    setEditMembers(suite.tests.map((t) => ({ id: t.testId, parallel: t.parallel })));
  };

  const handleSaveEdit = async (suiteId: number) => {
    setSavingMembers(true);
    try {
      const suiteMembers: QfSuiteMember[] = editMembers.map((m) => ({ testId: m.id, parallel: m.parallel }));
      await updateSuiteTests(suiteId, suiteMembers);
      toast.success("Members updated");
      setEditingSuite(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update members");
    } finally {
      setSavingMembers(false);
    }
  };

  const handleEvent = useCallback((event: QfEvent, suiteId: number) => {
    if (event.event === "suite") {
      if (event.type === "step") {
        setLog((prev) => [...prev, { label: `Step ${event.idx + 1}: ${event.intent}`, status: event.status }]);
      } else if (event.type === "test-done") {
        setLog((prev) => [...prev, { label: `Test #${event.testId} ${event.success ? "passed" : "failed"}`, status: event.success ? "passed" : "failed" }]);
      } else if (event.type === "suite-done") {
        setLog((prev) => [...prev, { label: `Suite ${event.success ? "passed" : "failed"}`, status: event.success ? "passed" : "failed" }]);
      }
    } else if (event.event === "done" && event.suiteRunId !== undefined) {
      getSuiteRun(event.suiteRunId)
        .then((r) => setRunDetails((prev) => ({ ...prev, [suiteId]: r.suiteRun })))
        .catch(() => {});
      listSuiteRuns(suiteId)
        .then((r) => setRecentRuns((prev) => ({ ...prev, [suiteId]: r.runs as RecentRun[] })))
        .catch(() => {});
    } else if (event.event === "error") {
      setLog((prev) => [...prev, { label: `Error: ${event.message}`, status: "failed" }]);
    }
  }, []);

  const handleRun = async (suite: QfSuite) => {
    setRunningSuite(suite.id);
    setLog([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await startSuiteRun(suite.id, { signal: ctrl.signal, onEvent: (e) => handleEvent(e, suite.id) });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        toast.error(err instanceof Error ? err.message : "Suite run failed");
      }
    } finally {
      setRunningSuite(null);
      abortRef.current = null;
      refresh();
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleDelete = async (suite: QfSuite) => {
    if (!window.confirm(`Delete suite "${suite.name}"? Runs history will be removed too.`)) return;
    try {
      await deleteSuite(suite.id);
      toast.success(`Suite "${suite.name}" deleted`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            Suites
            <span className="text-muted-foreground font-normal">(assign tests to Sequential or Parallel buckets per test)</span>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate((v) => !v)} className="ml-auto text-xs h-6">
              <Plus className="size-3.5 mr-1" /> New suite
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {showCreate && (
            <div className="space-y-3 border border-zinc-800 rounded-lg p-3 mb-3">
              <div>
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Signup flows" className="text-sm" />
              </div>
              {tests.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tests yet — record one in the Tests tab first.</p>
              ) : (
                <BucketsEditor
                  allItems={allTestItems}
                  members={members}
                  onChange={setMembers}
                  itemNoun="test"
                />
              )}
              <div className="flex gap-2">
                <Button onClick={handleCreate} disabled={creating || !name.trim()} className="text-xs h-8">
                  {creating ? "Creating…" : "Create suite"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)} className="text-xs h-8">Cancel</Button>
              </div>
            </div>
          )}

          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : suites.length === 0 ? (
            <p className="text-xs text-muted-foreground">No suites yet. Create one to group tests into a runnable batch.</p>
          ) : (
            <div className="space-y-3">
              {suites.map((suite) => (
                <Card key={suite.id}>
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{suite.name}</span>
                      <ModeBadge mode={suite.mode} />
                      <Badge variant="outline">{suite.tests.length} test(s)</Badge>
                      <div className="ml-auto flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="text-xs h-7" disabled={runningSuite !== null}
                          onClick={() => handleStartEdit(suite)}>
                          <Settings2 className="size-3.5" />
                        </Button>
                        <Button size="sm" className="text-xs h-7" disabled={runningSuite !== null} onClick={() => handleRun(suite)}>
                          {runningSuite === suite.id ? <RefreshCw className="size-3.5 mr-1 animate-spin" /> : <Play className="size-3.5 mr-1" />}
                          Run
                        </Button>
                        <Button size="sm" variant="ghost" className="text-xs h-7 text-muted-foreground hover:text-red-500" onClick={() => handleDelete(suite)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {editingSuite === suite.id ? (
                      <div className="space-y-2">
                        <BucketsEditor
                          allItems={allTestItems}
                          members={editMembers}
                          onChange={setEditMembers}
                          itemNoun="test"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" className="text-xs h-7" disabled={savingMembers} onClick={() => handleSaveEdit(suite.id)}>
                            {savingMembers ? "Saving…" : "Save members"}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setEditingSuite(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {suite.tests.length === 0 ? (
                          <span className="text-xs text-muted-foreground">No tests assigned</span>
                        ) : (
                          suite.tests.map((t) => (
                            <span
                              key={t.suiteTestId}
                              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${
                                t.parallel
                                  ? "border-blue-700/30 bg-blue-900/15 text-blue-300"
                                  : "border-amber-700/30 bg-amber-900/15 text-amber-300"
                              }`}
                              title={t.parallel ? "Runs in parallel" : "Runs in sequence"}
                            >
                              {t.parallel ? "\u22a5" : "\u2192"} {t.name}
                            </span>
                          ))
                        )}
                      </div>
                    )}

                    {runningSuite === suite.id && (
                      <div className="space-y-2">
                        <div className="border border-zinc-800 rounded-lg p-2 max-h-48 overflow-y-auto space-y-0.5">
                          {log.map((l, i) => (
                            <div key={i} className={`text-xs ${l.status === "failed" ? "text-red-400" : l.status === "passed" ? "text-green-400" : "text-muted-foreground"}`}>
                              {l.status === "failed" ? "\u2717" : l.status === "passed" ? "\u2713" : "\u2022"} {l.label}
                            </div>
                          ))}
                        </div>
                        <Button variant="destructive" size="sm" className="text-xs h-7" onClick={handleStop}>
                          <Square className="size-3 mr-1" /> Stop (after current test)
                        </Button>
                      </div>
                    )}

                    {runDetails[suite.id] && <SuiteRunCard suiteRun={runDetails[suite.id]} title={`Latest suite run #${runDetails[suite.id].id}`} />}

                    {recentRuns[suite.id] && recentRuns[suite.id].length > 1 && (
                      <p className="text-[11px] text-muted-foreground">
                        {recentRuns[suite.id].length} run(s) total — latest shown above.
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
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
  stopRun,
  updateSuite,
  updateSuiteApiSessions,
  updateSuiteTests,
  type QfEvent,
  type QfMode,
  type QfSuite,
  type QfSuiteMember,
  type QfSuiteRun,
  type QfSuiteType,
  type QfTest,
} from "@/lib/queryfirst-api";
import { listRecordedSessions, type RecordedSession } from "@/lib/fieldserve-api";
import { toast } from "sonner";
import { Play, Plus, RefreshCw, Square, Trash2, Settings2, Monitor, Server } from "lucide-react";
import { SuiteRunCard } from "./SuiteRunCard";
import { BucketsEditor, MemberGroupChips, partitionMembers, type BucketItem, type BucketMember } from "./BucketsEditor";

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

function SuiteCard({
  suite,
  runningSuite,
  log,
  runDetails,
  recentRuns,
  editingSuite,
  editMembers,
  savingMembers,
  allTestItems,
  allApiSessionItems,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditMembersChange,
  onRun,
  onStop,
  onDelete,
}: {
  suite: QfSuite;
  runningSuite: number | null;
  log: LogLine[];
  runDetails: Record<number, QfSuiteRun>;
  recentRuns: Record<number, RecentRun[]>;
  editingSuite: number | null;
  editMembers: BucketMember[];
  savingMembers: boolean;
  allTestItems: BucketItem[];
  allApiSessionItems: BucketItem[];
  onStartEdit: (suite: QfSuite) => void;
  onSaveEdit: (suiteId: number) => void;
  onCancelEdit: () => void;
  onEditMembersChange: (members: BucketMember[]) => void;
  onRun: (suite: QfSuite) => void;
  onStop: () => void;
  onDelete: (suite: QfSuite) => void;
}) {
  const isApi = suite.type === "api";
  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{suite.name}</span>
          <ModeBadge mode={suite.mode} />
          {isApi ? (
            <Badge variant="outline" className="border-amber-500/40 text-amber-400">{suite.apiSessions.length} session(s)</Badge>
          ) : (
            <Badge variant="outline">{suite.tests.length} test(s)</Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" className="text-xs h-7" disabled={runningSuite !== null}
              onClick={() => onStartEdit(suite)}>
              <Settings2 className="size-3.5" />
            </Button>
            <Button size="sm" className="text-xs h-7" disabled={runningSuite !== null} onClick={() => onRun(suite)}>
              {runningSuite === suite.id ? <RefreshCw className="size-3.5 mr-1 animate-spin" /> : <Play className="size-3.5 mr-1" />}
              Run
            </Button>
            <Button size="sm" variant="ghost" className="text-xs h-7 text-muted-foreground hover:text-red-500" onClick={() => onDelete(suite)}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {editingSuite === suite.id ? (
          <div className="space-y-2">
            <BucketsEditor
              allItems={isApi ? allApiSessionItems : allTestItems}
              members={editMembers}
              onChange={onEditMembersChange}
              itemNoun={isApi ? "session" : "test"}
            />
            <div className="flex gap-2">
              <Button size="sm" className="text-xs h-7" disabled={savingMembers} onClick={() => onSaveEdit(suite.id)}>
                {savingMembers ? "Saving…" : isApi ? "Save sessions" : "Save members"}
              </Button>
              <Button size="sm" variant="ghost" className="text-xs h-7" onClick={onCancelEdit}>Cancel</Button>
            </div>
          </div>
        ) : (
          isApi ? (
            <div className="flex flex-wrap gap-1">
              {suite.apiSessions.map((s) => (
                <Badge key={s.suiteApiSessionId} variant="outline" className="text-xs border-amber-500/30 text-white">
                  Session #{s.sessionId}
                </Badge>
              ))}
              {suite.apiSessions.length === 0 && (
                <p className="text-xs text-muted-foreground">No API sessions added.</p>
              )}
            </div>
          ) : (
            <MemberGroupChips
              groups={partitionMembers(suite.tests.map((t) => ({ id: t.testId, parallel: t.parallel })))}
              getLabel={(id) => suite.tests.find((t) => t.testId === id)?.name ?? `#${id}`}
            />
          )
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
            <Button variant="destructive" size="sm" className="text-xs h-7" onClick={onStop}>
              <Square className="size-3 mr-1" /> Stop
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
  );
}

export function SuitesPanel() {
  const [suites, setSuites] = useState<QfSuite[]>([]);
  const [tests, setTests] = useState<QfTest[]>([]);
  const [apiSessions, setApiSessions] = useState<RecordedSession[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<QfSuiteType>("ui");
  const [name, setName] = useState("");
  const [members, setMembers] = useState<BucketMember[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<number[]>([]);
  const [creating, setCreating] = useState(false);

  const [editingSuite, setEditingSuite] = useState<number | null>(null);
  const [editMembers, setEditMembers] = useState<BucketMember[]>([]);
  const [savingMembers, setSavingMembers] = useState(false);

  const [runningSuite, setRunningSuite] = useState<number | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [runDetails, setRunDetails] = useState<Record<number, QfSuiteRun>>({});
  const [recentRuns, setRecentRuns] = useState<Record<number, RecentRun[]>>({});
  const abortRef = useRef<AbortController | null>(null);

  const refreshRef = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshRef.current;
    const [s, t, api] = await Promise.allSettled([listSuites(), listTests(), listRecordedSessions()]);
    if (seq !== refreshRef.current) return;
    if (s.status === "fulfilled") setSuites(s.value.suites);
    if (t.status === "fulfilled") setTests(t.value.tests);
    if (api.status === "fulfilled") setApiSessions(api.value.sessions);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    return () => { abortRef.current?.abort(); };
  }, [refresh]);

  const uiSuites = suites.filter((s) => s.type === "ui");
  const apiSuites = suites.filter((s) => s.type === "api");

  const allTestItems: BucketItem[] = tests.map((t) => ({
    id: t.id,
    label: t.name,
    sublabel: `#${t.id}`,
  }));

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      if (createType === "api") {
        const { suite } = await createSuite({ name: name.trim(), type: "api", apiSessionIds: selectedSessionIds });
        toast.success(`API Suite "${suite.name}" created`);
      } else {
        const suiteMembers: QfSuiteMember[] = members.map((m) => ({ testId: m.id, parallel: m.parallel }));
        const { suite } = await createSuite({ name: name.trim(), tests: suiteMembers });
        toast.success(`Suite "${suite.name}" created`);
      }
      setName("");
      setMembers([]);
      setSelectedSessionIds([]);
      setShowCreate(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create suite");
    } finally {
      setCreating(false);
    }
  };

  const handleStartEdit = (suite: QfSuite) => {
    if (editingSuite === suite.id) {
      setEditingSuite(null);
      return;
    }
    setEditingSuite(suite.id);
    if (suite.type === "api") {
      setEditMembers(suite.apiSessions.map((s) => ({ id: s.sessionId, parallel: false })));
    } else {
      setEditMembers(suite.tests.map((t) => ({ id: t.testId, parallel: t.parallel })));
    }
  };

  const handleSaveEdit = async (suiteId: number) => {
    setSavingMembers(true);
    try {
      const suite = suites.find((s) => s.id === suiteId);
      if (suite?.type === "api") {
        await updateSuiteApiSessions(suiteId, editMembers.map((m) => m.id));
      } else {
        const suiteMembers: QfSuiteMember[] = editMembers.map((m) => ({ testId: m.id, parallel: m.parallel }));
        await updateSuiteTests(suiteId, suiteMembers);
      }
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

  const handleStop = async () => {
    try {
      await stopRun();
      refresh();
    } catch {
      /* ignore */
    }
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

  const openCreate = (type: QfSuiteType) => {
    setCreateType(type);
    setShowCreate(true);
    refresh();
  };

  const toggleSession = (id: number) => {
    setSelectedSessionIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const allApiSessionItems = apiSessions.map((s) => ({
    id: s.id,
    label: `${s.name} (Session #${s.id} · ${s.stepCount} step(s))`,
  }));

  const cardProps = {
    runningSuite,
    log,
    runDetails,
    recentRuns,
    editingSuite,
    editMembers,
    savingMembers,
    allTestItems,
    allApiSessionItems,
    onStartEdit: handleStartEdit,
    onSaveEdit: handleSaveEdit,
    onCancelEdit: () => setEditingSuite(null),
    onEditMembersChange: setEditMembers,
    onRun: handleRun,
    onStop: handleStop,
    onDelete: handleDelete,
  };

  return (
    <div className="space-y-4">
      {/* ---------- UI Test Suites ---------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Monitor className="size-4 text-blue-400" />
            UI Test Suites
            <span className="text-muted-foreground font-normal">(browser-based test recordings)</span>
            <Button variant="ghost" size="sm" onClick={() => openCreate("ui")} className="ml-auto text-xs h-6">
              <Plus className="size-3.5 mr-1" /> New suite
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : uiSuites.length === 0 ? (
            <p className="text-xs text-muted-foreground">No UI suites yet. Create one to group browser tests into a runnable batch.</p>
          ) : (
            <div className="space-y-3">
              {uiSuites.map((suite) => (
                <SuiteCard key={suite.id} suite={suite} {...cardProps} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- API Test Suites ---------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Server className="size-4 text-amber-400" />
            API Test Suites
            <span className="text-muted-foreground font-normal">(recorded HTTP API sessions)</span>
            <Button variant="ghost" size="sm" onClick={() => openCreate("api")} className="ml-auto text-xs h-6">
              <Plus className="size-3.5 mr-1" /> New suite
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : apiSuites.length === 0 ? (
            <p className="text-xs text-muted-foreground">No API suites yet. Create one to group API recordings into a runnable batch.</p>
          ) : (
            <div className="space-y-3">
              {apiSuites.map((suite) => (
                <SuiteCard key={suite.id} suite={suite} {...cardProps} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- Shared create dialog ---------- */}
      {showCreate && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium">
                Create {createType === "api" ? "API" : "UI"} Suite
              </span>
              <Button variant="ghost" size="sm" className="text-xs h-6 ml-auto" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={createType === "api" ? "e.g. FieldServe CRUD" : "e.g. Signup flows"} className="text-sm" />
            </div>

            {createType === "api" ? (
              <div className="space-y-2">
                {apiSessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No API recordings yet — record one in the API Tests tab first.</p>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    <Label className="text-xs">Select recorded sessions</Label>
                    {apiSessions.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-zinc-800/50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSessionIds.includes(s.id)}
                          onChange={() => toggleSession(s.id)}
                          className="rounded"
                        />
                        <span className="font-medium">{s.name}</span>
                        <span className="text-muted-foreground">#{s.id} · {s.stepCount} step(s)</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              tests.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tests yet — record one in the UI Tests tab first.</p>
              ) : (
                <BucketsEditor
                  allItems={allTestItems}
                  members={members}
                  onChange={setMembers}
                  itemNoun="test"
                />
              )
            )}

            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={creating || !name.trim()} className="text-xs h-8">
                {creating ? "Creating…" : "Create suite"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

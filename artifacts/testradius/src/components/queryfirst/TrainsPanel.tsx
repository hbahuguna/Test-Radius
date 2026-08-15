import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  createTrain,
  deleteTrain,
  getTrainRun,
  listSuites,
  listTrains,
  startTrainRun,
  stopRun,
  updateTrainSuites,
  type QfEvent,
  type QfMode,
  type QfSuite,
  type QfTrain,
  type QfTrainMember,
  type QfTrainRun,
} from "@/lib/queryfirst-api";
import { toast } from "sonner";
import { Play, Plus, RefreshCw, Square, Trash2, Settings2 } from "lucide-react";
import { SuiteRunCard } from "./SuiteRunCard";
import { BucketsEditor, MemberGroupChips, partitionMembers, type BucketItem, type BucketMember } from "./BucketsEditor";

interface LogLine {
  label: string;
  status: "passed" | "failed" | "skipped" | "info";
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

export function TrainsPanel() {
  const [trains, setTrains] = useState<QfTrain[]>([]);
  const [suites, setSuites] = useState<QfSuite[]>([]);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<BucketMember[]>([]);
  const [creating, setCreating] = useState(false);

  const [editingTrain, setEditingTrain] = useState<number | null>(null);
  const [editMembers, setEditMembers] = useState<BucketMember[]>([]);
  const [savingMembers, setSavingMembers] = useState(false);

  const [runningTrain, setRunningTrain] = useState<number | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [runDetails, setRunDetails] = useState<Record<number, QfTrainRun>>({});
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([listTrains(), listSuites()]);
      setTrains(t.trains);
      setSuites(s.suites);
    } catch {
      /* keep stale data */
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    return () => { abortRef.current?.abort(); };
  }, [refresh]);

  const allSuiteItems: BucketItem[] = suites.map((s) => ({
    id: s.id,
    label: s.name,
    sublabel: `${s.tests.length} tests`,
  }));

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const trainMembers: QfTrainMember[] = members.map((m) => ({ suiteId: m.id, parallel: m.parallel }));
      const { train } = await createTrain({ name: name.trim(), suites: trainMembers });
      toast.success(`Train "${train.name}" created`);
      setName("");
      setMembers([]);
      setShowCreate(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create train");
    } finally {
      setCreating(false);
    }
  };

  const handleStartEdit = (train: QfTrain) => {
    setEditingTrain(train.id);
    setEditMembers(train.suites.map((s) => ({ id: s.suiteId, parallel: s.parallel })));
  };

  const handleSaveEdit = async (trainId: number) => {
    setSavingMembers(true);
    try {
      const trainMembers: QfTrainMember[] = editMembers.map((m) => ({ suiteId: m.id, parallel: m.parallel }));
      await updateTrainSuites(trainId, trainMembers);
      toast.success("Members updated");
      setEditingTrain(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update members");
    } finally {
      setSavingMembers(false);
    }
  };

  const handleEvent = useCallback((event: QfEvent, trainId: number) => {
    if (event.event === "train") {
      if (event.type === "suite-start") {
        setLog((prev) => [...prev, { label: `Suite "${event.suiteName}" started`, status: "info" }]);
      } else if (event.type === "step") {
        setLog((prev) => [...prev, { label: `  Step ${event.idx + 1}: ${event.intent}`, status: event.status }]);
      } else if (event.type === "test-done") {
        setLog((prev) => [...prev, { label: `  Test #${event.testId} ${event.success ? "passed" : "failed"}`, status: event.success ? "passed" : "failed" }]);
      } else if (event.type === "suite-done") {
        setLog((prev) => [...prev, { label: `Suite ${event.success ? "passed" : "failed"}`, status: event.success ? "passed" : "failed" }]);
      } else if (event.type === "done") {
        setLog((prev) => [...prev, { label: `Train ${event.success ? "passed" : "failed"}`, status: event.success ? "passed" : "failed" }]);
      }
    } else if (event.event === "done" && event.trainRunId !== undefined) {
      getTrainRun(event.trainRunId)
        .then((r) => setRunDetails((prev) => ({ ...prev, [trainId]: r.trainRun })))
        .catch(() => {});
    } else if (event.event === "error") {
      setLog((prev) => [...prev, { label: `Error: ${event.message}`, status: "failed" }]);
    }
  }, []);

  const handleRun = async (train: QfTrain) => {
    setRunningTrain(train.id);
    setLog([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await startTrainRun(train.id, { signal: ctrl.signal, onEvent: (e) => handleEvent(e, train.id) });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        toast.error(err instanceof Error ? err.message : "Train run failed");
      }
    } finally {
      setRunningTrain(null);
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

  const handleDelete = async (train: QfTrain) => {
    if (!window.confirm(`Delete train "${train.name}"? Runs history will be removed too.`)) return;
    try {
      await deleteTrain(train.id);
      toast.success(`Train "${train.name}" deleted`);
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
            Trains
            <span className="text-muted-foreground font-normal">(sequence of steps; group 2+ suites to run in parallel)</span>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate((v) => !v)} className="ml-auto text-xs h-6">
              <Plus className="size-3.5 mr-1" /> New train
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {showCreate && (
            <div className="space-y-3 border border-zinc-800 rounded-lg p-3 mb-3">
              <div>
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly regression" className="text-sm" />
              </div>
              {suites.length === 0 ? (
                <p className="text-xs text-muted-foreground">No suites yet — create one in the Suites tab first.</p>
              ) : (
                <BucketsEditor
                  allItems={allSuiteItems}
                  members={members}
                  onChange={setMembers}
                  itemNoun="suite"
                />
              )}
              <div className="flex gap-2">
                <Button onClick={handleCreate} disabled={creating || !name.trim()} className="text-xs h-8">
                  {creating ? "Creating…" : "Create train"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)} className="text-xs h-8">Cancel</Button>
              </div>
            </div>
          )}

          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : trains.length === 0 ? (
            <p className="text-xs text-muted-foreground">No trains yet. Chain suites into a pipeline and run them.</p>
          ) : (
            <div className="space-y-3">
              {trains.map((train) => (
                <Card key={train.id}>
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{train.name}</span>
                      <ModeBadge mode={train.mode} />
                      <Badge variant="outline">{train.suites.length} suite(s)</Badge>
                      <div className="ml-auto flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="text-xs h-7" disabled={runningTrain !== null}
                          onClick={() => handleStartEdit(train)}>
                          <Settings2 className="size-3.5" />
                        </Button>
                        <Button size="sm" className="text-xs h-7" disabled={runningTrain !== null} onClick={() => handleRun(train)}>
                          {runningTrain === train.id ? <RefreshCw className="size-3.5 mr-1 animate-spin" /> : <Play className="size-3.5 mr-1" />}
                          Run
                        </Button>
                        <Button size="sm" variant="ghost" className="text-xs h-7 text-muted-foreground hover:text-red-500" onClick={() => handleDelete(train)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {editingTrain === train.id ? (
                      <div className="space-y-2">
                        <BucketsEditor
                          allItems={allSuiteItems}
                          members={editMembers}
                          onChange={setEditMembers}
                          itemNoun="suite"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" className="text-xs h-7" disabled={savingMembers} onClick={() => handleSaveEdit(train.id)}>
                            {savingMembers ? "Saving…" : "Save members"}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setEditingTrain(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <MemberGroupChips
                        groups={partitionMembers(train.suites.map((s) => ({ id: s.suiteId, parallel: s.parallel })))}
                        getLabel={(id) => train.suites.find((s) => s.suiteId === id)?.name ?? `Suite #${id}`}
                      />
                    )}

                    {runningTrain === train.id && (
                      <div className="space-y-2">
                        <div className="border border-zinc-800 rounded-lg p-2 max-h-48 overflow-y-auto space-y-0.5">
                          {log.map((l, i) => (
                            <div key={i} className={`text-xs ${l.status === "failed" ? "text-red-400" : l.status === "passed" ? "text-green-400" : "text-muted-foreground"}`}>
                              {l.status === "failed" ? "\u2717" : l.status === "passed" ? "\u2713" : "\u2022"} {l.label}
                            </div>
                          ))}
                        </div>
                        <Button variant="destructive" size="sm" className="text-xs h-7" onClick={handleStop}>
                          <Square className="size-3 mr-1" /> Stop
                        </Button>
                      </div>
                    )}

                    {runDetails[train.id] && (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground font-medium">Latest train run #{runDetails[train.id].id}: {runDetails[train.id].status}</p>
                        {runDetails[train.id].suiteRuns.map((sr) => {
                          const suiteName = train.suites.find((s) => s.suiteId === sr.suiteId)?.name ?? `Suite #${sr.suiteId}`;
                          return <SuiteRunCard key={sr.id} suiteRun={sr} title={suiteName} />;
                        })}
                      </div>
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
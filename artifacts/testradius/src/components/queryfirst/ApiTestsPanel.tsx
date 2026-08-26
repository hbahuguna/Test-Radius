import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  stopRecording,
  listRecordedSessions,
  getRecordedSession,
  exportRecordedSessionCsv,
  generateTestsFromRecording,
  replayRecordedSession,
  deleteRecordedSession,
  autopilotRecording,
  type RecordedSession,
  type RecordedStep,
  type AutopilotStep,
} from "@/lib/fieldserve-api";
import { ModelSelector, defaultModelFor } from "@/components/tester/ModelSelector";
import { type UserApiKey } from "@/lib/agentic-api";
import {
  runApiTests,
  resultsToCsv,
  type ParsedApiTest,
  type ApiTestResult,
  type ApiTestRun,
} from "@/lib/api-test-csv";
import { toast } from "sonner";
import {
  Play,
  Square,
  Sparkles,
  Trash2,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Clock,
  Download,
  Loader2,
  Circle,
  RotateCcw,
} from "lucide-react";

const COLORS: Record<string, string> = {
  created: "bg-blue-500/10 text-blue-400",
  scheduled: "bg-violet-500/10 text-violet-400",
  assigned: "bg-amber-500/10 text-amber-400",
  "engineer-dispatched": "bg-orange-500/10 text-orange-400",
  "en-route": "bg-orange-500/10 text-orange-400",
  "on-site": "bg-cyan-500/10 text-cyan-400",
  "checking-in": "bg-cyan-500/10 text-cyan-400",
  "waiting-for-access": "bg-yellow-500/10 text-yellow-400",
  "waiting-for-equipment": "bg-yellow-500/10 text-yellow-400",
  "in-progress": "bg-green-500/10 text-green-400",
  "on-hold": "bg-amber-500/10 text-amber-400",
  completed: "bg-green-600/20 text-green-400",
  failed: "bg-red-500/10 text-red-400",
  cancelled: "bg-zinc-500/10 text-zinc-400",
  deferred: "bg-indigo-500/10 text-indigo-400",
  "facility-not-accessible": "bg-red-500/10 text-red-300",
  "parts-required": "bg-red-500/10 text-red-300",
  "requires-rescheduling": "bg-red-500/10 text-red-300",
};

export function ApiTestsPanel() {
  // --- Seed/Reset state ---
  const [autoReset] = useState(true);

  // --- Generated Tests state ---
  const [aiTests, setAiTests] = useState<ParsedApiTest[]>([]);

  // --- Run History state ---
  const [runs, setRuns] = useState<ApiTestRun[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandedResult, setExpandedResult] = useState<number | null>(null);

  // --- Saved Tests state ---
  const [savedTests, setSavedTests] = useState<ParsedApiTest[]>([]);

  // --- Recording state ---
  const [recording, setRecording] = useState(false);
  const [recordedSessions, setRecordedSessions] = useState<RecordedSession[]>([]);
  const [scenario, setScenario] = useState("Test the full job lifecycle: create a job, assign an engineer, transition through all states to completion");
  const [baseUrl, setBaseUrl] = useState("/api/fieldserve");
  const [apiSpecUrl, setApiSpecUrl] = useState("/api/fieldserve/openapi.json");
  const [selectedSession, setSelectedSession] = useState<number | null>(null);
  const [selectedSessionSteps, setSelectedSessionSteps] = useState<RecordedStep[]>([]);
  const [expandedRecordedStep, setExpandedRecordedStep] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [generatingFromRecord, setGeneratingFromRecord] = useState(false);
  const [genRecordOutput, setGenRecordOutput] = useState("");

  // --- Autopilot state (AI-driven recording) ---
  const [autopilotRunning, setAutopilotRunning] = useState(false);
  const [autopilotOutput, setAutopilotOutput] = useState("");
  const [autopilotSteps, setAutopilotSteps] = useState<AutopilotStep[]>([]);
  const [selectedStepIdx, setSelectedStepIdx] = useState<number | null>(null);

  // --- LLM Model state ---
  const [provider, setProvider] = useState("openai");
  const [modelId, setModelId] = useState(defaultModelFor("openai"));
  const [keys, setKeys] = useState<UserApiKey[]>([]);

  // --- Activity Log ---
  const [log, setLog] = useState<{ msg: string; type: "info" | "pass" | "fail" | "error"; ts: number }[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((msg: string, type: "info" | "pass" | "fail" | "error") => {
    setLog((prev) => [...prev.slice(-200), { msg, type, ts: Date.now() }]);
  }, []);

  // --- Handlers ---

  const handleRunSavedTests = async () => {
    if (savedTests.length === 0) return;
    addLog(`Running ${savedTests.length} saved tests...`, "info");

    const run = await runApiTests(
      savedTests,
      (result, idx, total) => {
        const icon = result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "⚠";
        const color = result.status === "passed" ? "pass" : result.status === "failed" ? "fail" : "error";
        addLog(`${icon} ${result.method} ${result.path} → ${result.actual.statusCode} (${result.actual.duration}ms)`, color);
      },
      undefined,
      { autoReset },
    );

    setRuns((prev) => [run, ...prev]);
    addLog(`Run complete: ${run.passed}/${run.totalTests} passed`, run.failed === 0 ? "pass" : "fail");
    toast.success(`Run: ${run.passed}/${run.totalTests} passed`);
  };

  const handleRunAiTests = async () => {
    if (aiTests.length === 0) return;
    addLog(`Running ${aiTests.length} AI-generated tests...`, "info");

    const run = await runApiTests(
      aiTests,
      (result, idx, total) => {
        const icon = result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "⚠";
        const color = result.status === "passed" ? "pass" : result.status === "failed" ? "fail" : "error";
        addLog(`${icon} ${result.method} ${result.path} → ${result.actual.statusCode}`, color);
      },
      undefined,
      { autoReset },
    );

    setRuns((prev) => [run, ...prev]);
    addLog(`AI run complete: ${run.passed}/${run.totalTests} passed`, run.failed === 0 ? "pass" : "fail");
    toast.success(`AI run: ${run.passed}/${run.totalTests} passed`);
  };

  const handleAddToSaved = (tests: ParsedApiTest[]) => {
    setSavedTests((prev) => [...prev, ...tests]);
    toast.success(`Added ${tests.length} tests to saved list`);
  };

  const handleExportCsv = (run: ApiTestRun) => {
    const csv = resultsToCsv(run);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fieldserve-test-results-${run.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStopRecording = async () => {
    try {
      const result = await stopRecording();
      setRecording(false);
      const steps = result.session?.stepCount ?? 0;
      addLog(`Recording stopped — ${steps} steps captured`, "pass");
      loadRecordedSessions();

      if (steps > 0 && result.session) {
        addLog("Generating tests from recorded traffic...", "info");
        setGeneratingFromRecord(true);
        try {
          const { testCases } = await generateTestsFromRecording(
            result.session.id,
            {
              provider,
              modelId,
              scenario,
              onChunk: (chunk) => setGenRecordOutput((prev) => prev + chunk),
            },
          );
          if (testCases.length > 0) {
            const parsed: ParsedApiTest[] = testCases.map((tc: any) => ({
              name: tc.name || `${tc.method} ${tc.path}`,
              method: (tc.method || "GET").toUpperCase(),
              path: tc.path || "/",
              headers: tc.headers || {},
              body: typeof tc.body === "string" ? tc.body : JSON.stringify(tc.body ?? {}),
              expectedStatus: tc.expectedStatus || 200,
              assertions: tc.assertions || [],
              extractAs: null,
            }));
            setAiTests(parsed);
            addLog(`Generated ${parsed.length} tests from recording`, "pass");
            toast.success(`Generated ${parsed.length} tests from ${steps} recorded steps`);
          } else {
            addLog("No tests generated from recording", "error");
            toast.error("No tests generated");
          }
        } catch (genErr) {
          addLog(`Generate error: ${genErr instanceof Error ? genErr.message : "unknown"}`, "error");
          toast.error(genErr instanceof Error ? genErr.message : "Generation failed");
        } finally {
          setGeneratingFromRecord(false);
          setGenRecordOutput("");
        }
      }
    } catch (err) {
      addLog(`Recording failed to stop: ${err instanceof Error ? err.message : "unknown"}`, "error");
      toast.error(err instanceof Error ? err.message : "Failed to stop recording");
    }
  };

  const loadRecordedSessions = async () => {
    try {
      const result = await listRecordedSessions();
      setRecordedSessions(result.sessions);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadRecordedSessions();
    import("@/lib/agentic-api").then((m) => m.getApiKeys()).then(setKeys).catch(() => {});
  }, []);

  const handleSelectSession = async (sessionId: number) => {
    if (selectedSession === sessionId) {
      setSelectedSession(null);
      setSelectedSessionSteps([]);
      setExpandedRecordedStep(null);
      return;
    }
    setSelectedSession(sessionId);
    setExpandedRecordedStep(null);
    try {
      const result = await getRecordedSession(sessionId);
      setSelectedSessionSteps(result.steps);
    } catch {
      setSelectedSessionSteps([]);
    }
  };

  const handleExportRecording = async (sessionId: number) => {
    try {
      await exportRecordedSessionCsv(sessionId);
      toast.success("CSV downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  };

  const handleReplayRecording = async (sessionId: number) => {
    setReplaying(true);
    setAutopilotSteps([]);
    setSelectedStepIdx(null);
    addLog(`Replay started for session ${sessionId}`, "info");
    try {
      await loadRecordedSessions();
      const currentSessions = await listRecordedSessions().catch(() => ({ ok: false, sessions: [] as RecordedSession[] }));
      if (!currentSessions.sessions.some((s) => s.id === sessionId)) {
        const msg = "Session was deleted (likely by a reset). Please re-record.";
        addLog(`Replay error: ${msg}`, "error");
        toast.error(msg);
        setSelectedSession(null);
        setSelectedSessionSteps([]);
        setReplaying(false);
        return;
      }
      const result = await replayRecordedSession(sessionId, {
        baseUrl,
        provider,
        modelId,
        onStep: (s) => {
          setAutopilotSteps((prev) => [...prev, { stepNumber: s.seq, method: s.method, path: s.path, status: s.status, duration: s.duration, thinking: "", nextGoal: "", requestBody: s.requestBody, responseBody: s.responseBody, error: s.error } as AutopilotStep]);
          addLog(`  [${s.seq}] ${s.method} ${s.path} → ${s.status} (${s.duration}ms) ${s.pass ? "✓" : "✗ FAIL"}`, s.pass ? "pass" : "fail");
        },
        onHealing: (h) => {
          addLog(`  [${h.seq}] Healing: ${h.fixes.join(" → ")}`, "info");
        },
      });
      const passed = result.summary.passed;
      const failed = result.summary.failed;
      addLog(`Replay complete: ${passed} passed, ${failed} failed (of ${result.summary.total})`, failed === 0 ? "pass" : "fail");
      toast.success(`Replay complete: ${passed}/${result.summary.total} passed`);
    } catch (err) {
      addLog(`Replay error: ${err instanceof Error ? err.message : "unknown"}`, "error");
      toast.error(err instanceof Error ? err.message : "Replay failed");
    } finally {
      setReplaying(false);
    }
  };

  const handleGenerateFromRecording = async (sessionId: number) => {
    setGeneratingFromRecord(true);
    setGenRecordOutput("");
    try {
      const { testCases } = await generateTestsFromRecording(
        sessionId,
        {
          provider,
          modelId,
          scenario,
          onChunk: (chunk) => setGenRecordOutput((prev) => prev + chunk),
        },
      );
      if (testCases.length > 0) {
        const parsed: ParsedApiTest[] = testCases.map((tc: any) => ({
          name: tc.name || `${tc.method} ${tc.path}`,
          method: (tc.method || "GET").toUpperCase(),
          path: tc.path || "/",
          headers: tc.headers || {},
          body: typeof tc.body === "string" ? tc.body : JSON.stringify(tc.body ?? {}),
          expectedStatus: tc.expectedStatus || 200,
          assertions: tc.assertions || [],
          extractAs: null,
        }));
        setAiTests(parsed);
        addLog(`Generated ${parsed.length} tests from recording`, "pass");
        toast.success(`Generated ${parsed.length} tests`);
      }
    } catch (err) {
      addLog(`Generate from recording error: ${err instanceof Error ? err.message : "unknown"}`, "error");
      toast.error(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGeneratingFromRecord(false);
    }
  };

  const handleDeleteRecording = async (sessionId: number) => {
    try {
      await deleteRecordedSession(sessionId);
      setRecordedSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (selectedSession === sessionId) setSelectedSession(null);
      toast.success("Session deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleAutopilot = async () => {
    if (!scenario.trim()) {
      toast.error("Write a scenario to test first");
      return;
    }
    setAutopilotRunning(true);
    setAutopilotOutput("");
    setAutopilotSteps([]);
    setSelectedStepIdx(null);
    addLog(`Autopilot started: "${scenario.trim().slice(0, 60)}"`, "info");
    try {
      const { session } = await autopilotRecording(scenario, {
        baseUrl,
        apiSpecUrl: apiSpecUrl || undefined,
        provider,
        modelId,
        onThinking: (chunk) => setAutopilotOutput((prev) => prev + chunk),
        onStep: (s) => {
          setAutopilotSteps((prev) => [...prev, s]);
          if (s.method) {
            addLog(`${s.method} ${s.path} → ${s.status} (${s.duration}ms)`, s.status < 400 ? "pass" : "fail");
          }
        },
      });
      const steps = session?.stepCount ?? 0;
      addLog(`Autopilot complete — ${steps} steps recorded`, "pass");
      toast.success(`Autopilot complete — ${steps} steps recorded`);
      loadRecordedSessions();
    } catch (err) {
      addLog(`Autopilot error: ${err instanceof Error ? err.message : "unknown"}`, "error");
      toast.error(err instanceof Error ? err.message : "Autopilot failed");
    } finally {
      setAutopilotRunning(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr_360px] gap-4">
      {/* LEFT: Controls */}
      <div className="space-y-4">
        {/* Recording */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Record API Test</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recording ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <Circle className="size-3 fill-red-500 animate-pulse" />
                  Recording API traffic...
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Make API requests via the Request Builder or externally.
                  Tests will be generated when you stop.
                </p>
                <Button size="sm" variant="destructive" onClick={handleStopRecording} className="w-full">
                  <Square className="size-3 mr-1" /> Stop Recording
                </Button>
              </div>
            ) : (
              <>
                <div>
                  <Label className="text-xs">Scenario to test</Label>
                  <Textarea
                    value={scenario}
                    onChange={(e) => setScenario(e.target.value)}
                    rows={3}
                    className="text-sm"
                    placeholder="e.g. Create a job, assign engineer, transition through all states to completion"
                  />
                </div>
                <div>
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="text-sm font-mono"
                  />
                </div>
                <div>
                  <Label className="text-xs">API Spec URL <span className="text-muted-foreground">(optional)</span></Label>
                  <Input
                    value={apiSpecUrl}
                    onChange={(e) => setApiSpecUrl(e.target.value)}
                    placeholder="https://petstore.swagger.io/v2/swagger.json"
                    className="text-sm font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    OpenAPI/Swagger spec URL. When provided, the AI uses endpoint schemas to generate correct request payloads.
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={handleAutopilot}
                  disabled={autopilotRunning || replaying || recording}
                  className="w-full"
                >
                  {autopilotRunning ? <Loader2 className="size-3 animate-spin mr-1" /> : <Sparkles className="size-3 mr-1" />}
                  Record
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  The AI reads your scenario + the API spec, drives the requests itself, and records a replayable session.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* LLM Model */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">LLM Model (for recording / generation)</CardTitle>
          </CardHeader>
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

        {/* Replay */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Replay</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Select a recorded session</Label>
              {recordedSessions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No sessions yet. Record one above.</p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {recordedSessions.map((s) => (
                    <div
                      key={s.id}
                      className={`flex items-center gap-2 p-1.5 rounded text-xs cursor-pointer border ${
                        selectedSession === s.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/50"
                      }`}
                      onClick={() => handleSelectSession(s.id)}
                    >
                      <span className="flex-1 truncate">{s.name}</span>
                      <span className="text-muted-foreground">{s.stepCount} steps</span>
                      <Trash2
                        className="size-3.5 text-muted-foreground hover:text-red-500"
                        onClick={(e) => { e.stopPropagation(); handleDeleteRecording(s.id); }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedSession !== null && selectedSessionSteps.length > 0 && (
              <div>
                <Label className="text-xs">Steps ({selectedSessionSteps.length})</Label>
                <div className="mt-1 space-y-0.5 max-h-52 overflow-y-auto rounded border bg-muted/20 p-1">
                  {selectedSessionSteps.map((step) => (
                    <div key={step.id}>
                      <div
                        className="flex items-center gap-1.5 px-1.5 py-1 rounded text-xs hover:bg-muted/60 cursor-pointer"
                        onClick={() => setExpandedRecordedStep(expandedRecordedStep === step.id ? null : step.id)}
                      >
                        {expandedRecordedStep === step.id ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                        <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none ${
                          step.responseStatus < 400 ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
                        }`}>
                          {step.method}
                        </span>
                        <span className="flex-1 truncate font-mono">{step.path}</span>
                        <span className="text-muted-foreground">{step.responseStatus}</span>
                        <span className="text-muted-foreground">{step.durationMs}ms</span>
                      </div>
                      {expandedRecordedStep === step.id && (
                        <div className="ml-5 mt-0.5 mb-1 space-y-1 text-xs">
                          {step.requestBody && (
                            <div>
                              <span className="text-muted-foreground">Request body:</span>
                              <pre className="text-foreground/90 mt-0.5 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">{(() => { try { return JSON.stringify(JSON.parse(step.requestBody), null, 2); } catch { return step.requestBody; } })()}</pre>
                            </div>
                          )}
                          {step.responseBody && (
                            <div>
                              <span className="text-muted-foreground">Response ({step.responseStatus}):</span>
                              <pre className="text-foreground/90 mt-0.5 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{(() => { try { return JSON.stringify(JSON.parse(step.responseBody), null, 2); } catch { return step.responseBody; } })()}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex gap-1 mt-2">
                  <Button
                    size="sm"
                    onClick={() => handleReplayRecording(selectedSession)}
                    disabled={replaying || autopilotRunning}
                    className="flex-1"
                  >
                    <RotateCcw className="size-3 mr-1" /> {replaying ? "Replaying..." : "Replay"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleExportRecording(selectedSession)}
                  >
                    <Download className="size-3 mr-1" /> CSV
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleGenerateFromRecording(selectedSession)}
                    disabled={generatingFromRecord}
                  >
                    <Sparkles className="size-3 mr-1" /> Generate
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Generated Tests */}
        {aiTests.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>Generated Tests ({aiTests.length})</span>
                <div className="flex gap-1">
                  <Button size="sm" onClick={handleRunAiTests}>
                    <Play className="size-3 mr-1" /> Run
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleAddToSaved(aiTests)}>
                    Save
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-[200px] overflow-y-auto space-y-1">
                {aiTests.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs p-1">
                    <span className="font-mono text-muted-foreground w-12">{t.method}</span>
                    <span className="truncate flex-1">{t.path}</span>
                    <span className="text-muted-foreground">{t.expectedStatus}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Saved Tests */}
        {savedTests.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>Saved Tests ({savedTests.length})</span>
                <Button size="sm" onClick={handleRunSavedTests}>
                  <Play className="size-3 mr-1" /> Run
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {savedTests.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-muted-foreground w-12">{t.method}</span>
                    <span className="truncate">{t.path}</span>
                  </div>
                ))}
              </div>
              <Button size="sm" variant="ghost" className="w-full mt-2" onClick={() => setSavedTests([])}>
                Clear All
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* CENTER: Response */}
      <div className="space-y-4">
        {/* AI Output (streaming) */}
        {generatingFromRecord && genRecordOutput && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="size-4 animate-pulse" />
                Generating Tests...
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs font-mono bg-zinc-900 rounded p-3 overflow-auto max-h-60 whitespace-pre-wrap">
                {genRecordOutput}
              </pre>
            </CardContent>
          </Card>
        )}

        {/* Autopilot / Replay progress */}
        {((autopilotRunning || replaying) || autopilotSteps.length > 0) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className={`size-4 ${autopilotRunning || replaying ? "animate-pulse" : ""}`} />
                {replaying ? "Replay" : "Autopilot"} {autopilotRunning || replaying ? "running\u2026" : "complete"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 max-h-80 overflow-y-auto overscroll-contain">
              {autopilotSteps.length > 0 && (
                <div className="space-y-1 max-h-60 overflow-y-auto overscroll-contain rounded border bg-muted/20 p-1">
                  {autopilotSteps.map((s, i) => (
                    <div
                      key={i}
                      onClick={() => setSelectedStepIdx(selectedStepIdx === i ? null : i)}
                      className={`flex items-center gap-1.5 px-1.5 py-1 rounded text-xs cursor-pointer transition-colors ${
                        selectedStepIdx === i
                          ? "bg-primary/10 ring-1 ring-primary/30"
                          : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="text-muted-foreground w-5 shrink-0">{s.stepNumber || "✓"}</span>
                      <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none ${
                        !s.method ? "bg-zinc-500/10 text-zinc-400" : s.status < 400 ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
                      }`}>
                        {s.method || "done"}
                      </span>
                      <span className="flex-1 truncate font-mono">{s.path || s.nextGoal}</span>
                      {s.method && <span className="text-muted-foreground">{s.status}</span>}
                      {s.method && <span className="text-muted-foreground">{s.duration}ms</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Step detail panel */}
              {selectedStepIdx !== null && autopilotSteps[selectedStepIdx] && (
                <div className="rounded border bg-zinc-900/80 p-3 space-y-2 text-xs font-mono overflow-auto max-h-80">
                  {(() => {
                    const s = autopilotSteps[selectedStepIdx];
                    return (
                      <>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          {s.method && <span className="font-bold text-foreground">{s.method} {s.path}</span>}
                          {s.status > 0 && (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${s.status < 400 ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                              {s.status}
                            </span>
                          )}
                          {s.duration > 0 && <span>{s.duration}ms</span>}
                        </div>
                        {s.thinking && (
                          <div>
                            <span className="text-muted-foreground">Thinking:</span>
                            <p className="text-foreground/80 mt-0.5 whitespace-pre-wrap">{s.thinking}</p>
                          </div>
                        )}
                        {s.requestBody && (
                          <div>
                            <span className="text-muted-foreground">Request body:</span>
                            <pre className="text-foreground/90 mt-0.5 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">{(() => { try { return JSON.stringify(JSON.parse(s.requestBody), null, 2); } catch { return s.requestBody; } })()}</pre>
                          </div>
                        )}
                        {s.responseBody && (
                          <div>
                            <span className="text-muted-foreground">Response ({s.status}):</span>
                            <pre className="text-foreground/90 mt-0.5 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{(() => { try { return JSON.stringify(JSON.parse(s.responseBody!), null, 2); } catch { return s.responseBody; } })()}</pre>
                          </div>
                        )}
                        {s.error && (
                          <div className="text-red-400">
                            <span>Error:</span> {s.error}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {autopilotOutput && !selectedStepIdx && (
                <pre className="text-xs font-mono bg-zinc-900 rounded p-3 overflow-auto max-h-40 whitespace-pre-wrap break-all">
                  {autopilotOutput.slice(-1500)}
                </pre>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* RIGHT: Activity Log + History */}
      <div className="space-y-4">
        {/* Activity Log */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between">
              <span>Activity Log</span>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setLog([])}>
                Clear
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-[400px] overflow-y-auto space-y-1 font-mono text-xs">
              {log.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
              {log.map((entry, i) => (
                <div
                  key={i}
                  className={`border-l-2 pl-2 py-0.5 ${
                    entry.type === "pass"
                      ? "border-green-500"
                      : entry.type === "fail"
                        ? "border-red-500"
                        : entry.type === "error"
                          ? "border-red-700"
                          : "border-zinc-600"
                  }`}
                >
                  <span className="text-muted-foreground">{new Date(entry.ts).toLocaleTimeString()}</span>{" "}
                  <span
                    className={
                      entry.type === "pass"
                        ? "text-green-400"
                        : entry.type === "fail"
                          ? "text-red-400"
                          : entry.type === "error"
                            ? "text-red-300"
                            : "text-zinc-400"
                    }
                  >
                    {entry.msg}
                  </span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </CardContent>
        </Card>

        {/* Run History */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Run History ({runs.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-[400px] overflow-y-auto space-y-2">
              {runs.length === 0 && <p className="text-xs text-muted-foreground">No runs yet.</p>}
              {runs.map((run) => (
                <div key={run.id} className="border border-zinc-800 rounded">
                  <button
                    className="w-full flex items-center justify-between p-2 text-xs hover:bg-zinc-800/50"
                    onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                  >
                    <div className="flex items-center gap-2">
                      {expandedRun === run.id ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                      <span className="font-mono text-muted-foreground">{run.type}</span>
                      <span>{new Date(run.startedAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-green-400">{run.passed}✓</span>
                      <span className="text-red-400">{run.failed}✗</span>
                      {run.errors > 0 && <span className="text-amber-400">{run.errors}⚠</span>}
                      <span className="text-muted-foreground">{run.duration}ms</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={(e) => { e.stopPropagation(); handleExportCsv(run); }}
                      >
                        <Download className="size-3" />
                      </Button>
                    </div>
                  </button>
                  {expandedRun === run.id && (
                    <div className="border-t border-zinc-800 p-2 space-y-2">
                      {Object.keys(run.variables).length > 0 && (
                        <div className="p-2 bg-zinc-800/50 rounded text-xs">
                          <span className="text-muted-foreground font-medium">Captured variables:</span>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {Object.entries(run.variables).map(([k, v]) => (
                              <span key={k} className="font-mono bg-zinc-700/50 px-1.5 py-0.5 rounded">
                                <span className="text-cyan-400">{k}</span>=<span className="text-zinc-300">{v}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {run.results.map((result, ri) => (
                        <div key={ri}>
                          <button
                            className="w-full flex items-center gap-2 text-xs p-1 hover:bg-zinc-800/50 rounded"
                            onClick={() => setExpandedResult(expandedResult === ri ? null : ri)}
                          >
                            {result.status === "passed" ? (
                              <Check className="size-3 text-green-400" />
                            ) : result.status === "failed" ? (
                              <X className="size-3 text-red-400" />
                            ) : (
                              <Clock className="size-3 text-amber-400" />
                            )}
                            <span className="font-mono text-muted-foreground w-12">{result.method}</span>
                            <span className="truncate flex-1 text-left">{result.path}</span>
                            <span className="text-muted-foreground">{result.actual.statusCode}</span>
                            <span className="text-muted-foreground">{result.actual.duration}ms</span>
                          </button>
                          {expandedResult === ri && (
                            <div className="ml-6 mt-1 p-2 bg-zinc-900 rounded text-xs space-y-1">
                              <div>
                                <strong>Status:</strong> {result.actual.statusCode}
                                {result.assertionResults.length > 0 && (
                                  <span className="ml-2 text-muted-foreground">
                                    ({result.assertionResults.filter((a) => a.passed).length}/{result.assertionResults.length} assertions)
                                  </span>
                                )}
                              </div>
                              {result.extractedVariable && (
                                <div className="text-cyan-400">
                                  Extracted: <code>{result.extractedVariable.name}</code> = <code>{result.extractedVariable.value}</code>
                                </div>
                              )}
                              {result.assertionResults.map((a, ai) => (
                                <div key={ai} className={a.passed ? "text-green-400" : "text-red-400"}>
                                  {a.passed ? "✓" : "✗"} {a.target} {a.operator} {a.expected} (actual: {a.actual})
                                </div>
                              ))}
                              {result.error && <div className="text-red-400">Error: {result.error}</div>}
                              <pre className="text-muted-foreground overflow-auto max-h-32 whitespace-pre-wrap break-all">
                                {(() => {
                                  try { return JSON.stringify(JSON.parse(result.actual.body), null, 2); }
                                  catch { return result.actual.body.slice(0, 500); }
                                })()}
                              </pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

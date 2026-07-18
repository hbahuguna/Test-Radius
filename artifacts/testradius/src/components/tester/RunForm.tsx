import { useState, type ClipboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Play, Sparkles, Search } from "lucide-react";
import { type Assertion } from "@/lib/agentic-api";
import { importJira, searchJira, spendCredit, type JiraSearchResult } from "@/lib/agentic-api";
import { ModelSelector, defaultModelFor } from "./ModelSelector";
import { AssertionEditor } from "./AssertionEditor";
import { type UserApiKey } from "@/lib/agentic-api";
import { toast } from "sonner";
import { useLocation } from "wouter";

interface RunFormProps {
  url: string;
  goal: string;
  assertions: Assertion[];
  model: string;
  modelId: string;
  keys: UserApiKey[];
  loading: boolean;
  onUrlChange: (v: string) => void;
  onGoalChange: (v: string) => void;
  onAssertionsChange: (a: Assertion[]) => void;
  onModelChange: (m: string) => void;
  onModelIdChange: (m: string) => void;
  onRun: () => void;
}

export function RunForm({
  url,
  goal,
  assertions,
  model,
  modelId,
  keys,
  loading,
  onUrlChange,
  onGoalChange,
  onAssertionsChange,
  onModelChange,
  onModelIdChange,
  onRun,
}: RunFormProps) {
  const [jiraOpen, setJiraOpen] = useState(false);
  const [jiraTicket, setJiraTicket] = useState("");
  const [jiraQuery, setJiraQuery] = useState("");
  const [jiraResults, setJiraResults] = useState<JiraSearchResult[]>([]);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraSearching, setJiraSearching] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [, navigate] = useLocation();

  // Pasting external content into the goal uses 1 credit. Typing is free.
  const handleGoalPaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted.trim()) return;
    e.preventDefault();
    try {
      const bal = await spendCredit("paste_goal");
      // Best-effort: refresh parent credit display if it exposes a setter.
      onGoalChange(goal + (goal && !goal.endsWith("\n") ? "\n" : "") + pasted);
      toast.success("Goal pasted. 1 credit used.");
    } catch (err: any) {
      if (err?.code === "insufficient_credits") {
        toast.error("No credits remaining. Redirecting to buy credits…");
        setTimeout(() => navigate("/pricing"), 1200);
      } else {
        toast.error(err?.message || "Failed to paste goal");
      }
    }
  };

  const runImport = async (key: string) => {
    setJiraLoading(true);
    setJiraError(null);
    try {
      const result = await importJira(key);
      if (result.goal) onGoalChange(result.goal);
      if (result.url) onUrlChange(result.url);
      if (result.assertions && result.assertions.length) onAssertionsChange(result.assertions);
      setJiraOpen(false);
      setJiraTicket("");
      setJiraQuery("");
      setJiraResults([]);
    } catch (e: any) {
      setJiraError(e?.message || "Failed to import Jira ticket");
    } finally {
      setJiraLoading(false);
    }
  };

  const handleJiraImport = () => runImport(jiraTicket.trim());

  const handleJiraSearch = async () => {
    if (!jiraQuery.trim()) return;
    setJiraSearching(true);
    setJiraError(null);
    try {
      const results = await searchJira(jiraQuery.trim());
      setJiraResults(results);
      if (results.length === 0) setJiraError("No matching issues found.");
    } catch (e: any) {
      setJiraError(e?.message || "Failed to search Jira");
    } finally {
      setJiraSearching(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="url">Target URL</Label>
        <Input
          id="url"
          placeholder="https://example.com"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="goal">Goal</Label>
          <Dialog open={jiraOpen} onOpenChange={setJiraOpen}>
            <DialogTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-primary">
                <Sparkles className="h-3.5 w-3.5" /> Import from Jira
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Import from Jira</DialogTitle>
                <DialogDescription>
                  Paste a Jira ticket key or URL. We'll pull the summary and acceptance
                  criteria into your test goal. This uses 1 credit.
                </DialogDescription>
              </DialogHeader>
              {!keys.some((k) => k.provider === "jira") ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Connect your Jira instance first. Add your Jira Base URL, email, and API
                    token in Settings, then come back to import tickets.
                  </p>
                  <DialogFooter>
                    <a href="/settings">
                      <Button type="button" variant="outline">Go to Settings</Button>
                    </a>
                  </DialogFooter>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="jira-search">Search Jira</Label>
                    <div className="flex gap-2">
                      <Input
                        id="jira-search"
                        placeholder="Search by summary, description, or any text…"
                        value={jiraQuery}
                        onChange={(e) => setJiraQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleJiraSearch();
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleJiraSearch}
                        disabled={jiraSearching || !jiraQuery.trim()}
                      >
                        <Search className="h-4 w-4" />
                        {jiraSearching ? "Searching…" : "Search"}
                      </Button>
                    </div>
                  </div>

                  {jiraResults.length > 0 && (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {jiraResults.map((r) => (
                        <button
                          key={r.key}
                          type="button"
                          onClick={() => runImport(r.key)}
                          disabled={jiraLoading}
                          className="w-full text-left rounded-lg border border-border p-3 hover:bg-muted/50 transition-colors disabled:opacity-50"
                        >
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium text-primary">{r.key}</span>
                            {r.type && <span>· {r.type}</span>}
                            {r.status && <span>· {r.status}</span>}
                          </div>
                          <p className="text-sm mt-1">{r.summary}</p>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="border-t pt-3 space-y-1.5">
                    <Label htmlFor="jira">Or paste a ticket key / URL</Label>
                    <Input
                      id="jira"
                      placeholder="TEST-123 or https://your-domain.atlassian.net/browse/TEST-123"
                      value={jiraTicket}
                      onChange={(e) => setJiraTicket(e.target.value)}
                    />
                  </div>

                  {jiraError && (
                    <p className="text-sm text-destructive">{jiraError}</p>
                  )}

                  <DialogFooter>
                    <Button
                      type="button"
                      onClick={handleJiraImport}
                      disabled={jiraLoading || !jiraTicket.trim()}
                    >
                      {jiraLoading ? "Importing…" : "Import ticket"}
                    </Button>
                  </DialogFooter>
                  <p className="text-xs text-muted-foreground">
                    Importing a ticket uses 1 credit.
                  </p>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
        <Textarea
          id="goal"
          placeholder="Describe what the agent should do, e.g. Submit the contact form with test data"
          value={goal}
          onChange={(e) => onGoalChange(e.target.value)}
          onPaste={handleGoalPaste}
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          Typing a goal is free. Importing from Jira or pasting text into this
          field each use <span className="font-medium text-foreground">1 credit</span>.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>Model</Label>
        <ModelSelector
          provider={model}
          modelId={modelId}
          onProviderChange={(p) => {
            onModelChange(p);
            onModelIdChange(defaultModelFor(p));
          }}
          onModelIdChange={onModelIdChange}
          keys={keys}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Assertions (optional)</Label>
        <AssertionEditor assertions={assertions} onChange={onAssertionsChange} />
      </div>

      <Button
        type="button"
        disabled={loading || !url || !goal}
        onClick={onRun}
        className="w-full h-11 text-base font-medium shadow-sm hover:shadow-md transition-all"
      >
        <Play className="h-4 w-4" />
        {loading ? "Running…" : "Run Test"}
      </Button>
    </div>
  );
}

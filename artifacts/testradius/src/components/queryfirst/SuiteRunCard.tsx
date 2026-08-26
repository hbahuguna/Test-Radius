import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listSuiteScreenshots, type QfScreenshotRef, type QfSuiteRun } from "@/lib/queryfirst-api";
import { Camera } from "lucide-react";

function statusBadge(status: string) {
  if (status === "passed") return <Badge className="bg-green-500/20 text-green-300 border-green-500/30">PASS</Badge>;
  if (status === "failed") return <Badge className="bg-red-500/20 text-red-300 border-red-500/30">FAIL</Badge>;
  return <Badge className="bg-zinc-500/15 text-zinc-300 border-zinc-500/30">{status.toUpperCase()}</Badge>;
}

export function SuiteRunCard({ suiteRun, title }: { suiteRun: QfSuiteRun; title?: string }) {
  const [shots, setShots] = useState<QfScreenshotRef[]>([]);
  const [openShot, setOpenShot] = useState<QfScreenshotRef | null>(null);
  const [shotsLoading, setShotsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setShotsLoading(true);
    listSuiteScreenshots(suiteRun.id)
      .then((r) => { if (!cancelled) setShots(r.screenshots); })
      .catch(() => { if (!cancelled) setShots([]); })
      .finally(() => { if (!cancelled) setShotsLoading(false); });
    return () => { cancelled = true; };
  }, [suiteRun.id]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs flex items-center gap-2">
          {title ?? `Suite run #${suiteRun.id}`}
          {statusBadge(suiteRun.status)}
          <span className="text-muted-foreground font-normal">mode: {suiteRun.mode}</span>
          <span className="text-muted-foreground font-normal ml-auto">
            {new Date(suiteRun.startedAt).toLocaleTimeString()}
            {suiteRun.finishedAt ? ` → ${new Date(suiteRun.finishedAt).toLocaleTimeString()}` : ""}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          {suiteRun.runs.map((r) => (
            <div key={r.runId} className="flex items-center gap-2 text-xs py-0.5">
              {statusBadge(r.status)}
              <span className="truncate flex-1">{r.name || `Test #${r.testId}`}</span>
              <span className="text-muted-foreground font-mono">#{r.runId}</span>
              {r.error && <span className="text-red-500 truncate max-w-[240px]" title={r.error}>{r.error}</span>}
            </div>
          ))}
        </div>

        {suiteRun.runs.length === 0 && <p className="text-xs text-muted-foreground">No member runs recorded.</p>}

        {shotsLoading ? (
          <p className="text-xs text-muted-foreground">Loading screenshots…</p>
        ) : shots.length > 0 ? (
          <div>
            <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
              <Camera className="size-3" /> {shots.length} step screenshot(s) — click to view
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {shots.map((s) => (
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
          </div>
        ) : null}

        <Dialog open={openShot !== null} onOpenChange={(o) => { if (!o) setOpenShot(null); }}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle className="text-sm font-mono">{openShot?.path}</DialogTitle>
            </DialogHeader>
            {openShot && <img src={openShot.url} alt={openShot.path} className="w-full rounded border border-zinc-800" />}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

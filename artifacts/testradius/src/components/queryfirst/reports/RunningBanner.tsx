import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getActiveRun, stopRun, type QfActiveRun } from "@/lib/queryfirst-api";
import { Square } from "lucide-react";

/**
 * "Running now" banner for the reports pages. Polls the server for the user's
 * active suite/train run and offers a Stop button that aborts it server-side
 * (kills a hung test). Calls `onFinished` whenever an active run disappears —
 * either because the user stopped it or it completed — so the list refreshes.
 */
export function RunningBanner({ onFinished }: { onFinished?: () => void }) {
  const [active, setActive] = useState<QfActiveRun | null>(null);
  const [stopping, setStopping] = useState(false);
  const prevActive = useRef<QfActiveRun | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await getActiveRun();
      setActive(r.active);
    } catch {
      /* keep stale state */
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    if (prevActive.current && !active) onFinished?.();
    prevActive.current = active;
  }, [active, onFinished]);

  if (!active) return null;

  const kindLabel = active.kind === "suite" ? "suite" : "train";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2">
      <span className="flex items-center gap-2 text-sm font-medium text-red-400">
        <Square className="size-3 animate-pulse" />
        {active.name} ({kindLabel} #{active.entityId}) is running…
      </span>
      <Button
        variant="destructive"
        size="sm"
        className="ml-auto text-xs h-7"
        disabled={stopping}
        onClick={async () => {
          setStopping(true);
          try {
            await stopRun();
            setActive(null);
          } catch {
            /* ignore */
          } finally {
            setStopping(false);
          }
        }}
      >
        {stopping ? "Stopping…" : "Stop run"}
      </Button>
    </div>
  );
}

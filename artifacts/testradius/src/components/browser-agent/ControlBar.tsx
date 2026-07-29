import { Button } from "@/components/ui/button";
import { Play, Square, RotateCcw } from "lucide-react";

interface ControlBarProps {
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  startDisabled?: boolean;
}

export function ControlBar({
  status,
  onStart,
  onStop,
  onClear,
  startDisabled,
}: ControlBarProps) {
  const isRunning = status === "running";

  return (
    <div className="flex items-center gap-2">
      {isRunning ? (
        <Button
          variant="destructive"
          onClick={onStop}
          className="gap-2"
        >
          <Square className="h-4 w-4" />
          Stop
        </Button>
      ) : (
        <>
          <Button
            onClick={onStart}
            disabled={startDisabled}
            className="gap-2"
          >
            <Play className="h-4 w-4" />
            Start Agent
          </Button>
          {(status === "completed" || status === "failed" || status === "stopped") && (
            <Button
              variant="outline"
              onClick={onClear}
              className="gap-2"
            >
              <RotateCcw className="h-4 w-4" />
              New Run
            </Button>
          )}
        </>
      )}
    </div>
  );
}

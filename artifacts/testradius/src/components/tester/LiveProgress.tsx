import { CheckCircle2, XCircle, Loader2, Circle } from "lucide-react";

export interface StepEvent {
  step?: number;
  total?: number;
  action?: string;
  target?: string;
  status?: string;
  detail?: string;
}

interface LiveProgressProps {
  steps: StepEvent[];
  screenshot: string | null;
  status: "idle" | "running" | "done" | "failed" | "stopped";
  success?: boolean | null;
}

export function LiveProgress({ steps, screenshot, status, success }: LiveProgressProps) {
  return (
    <div className="space-y-4">
      {screenshot && (
        <div className="bg-muted rounded-lg overflow-hidden min-h-[480px] max-h-[640px] flex items-center justify-center">
          <img
            src={`data:image/png;base64,${screenshot}`}
            alt="Live browser"
            className="w-full h-full object-contain"
          />
        </div>
      )}

      {/* Steps - browser-use style */}
      {(steps.length > 0 || status !== "idle") && (
        <div className="space-y-2 max-h-[640px] overflow-y-auto">
          {steps.length === 0 && status !== "running" && (
            <p className="text-sm text-muted-foreground">Run steps will appear here.</p>
          )}
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <StatusIcon status={s.status} />
              <span className="text-muted-foreground">{s.action}</span>
            </div>
          ))}
          {status === "done" && (
            <div className="flex items-center gap-2 pt-2 font-medium">
              {success ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-600" /> Done
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-red-600" /> Failed
                </>
              )}
            </div>
          )}
          {status === "failed" && (
            <div className="flex items-center gap-2 pt-2 font-medium text-red-600">
              <XCircle className="h-5 w-5" /> Run failed
            </div>
          )}
          {status === "stopped" && (
            <div className="flex items-center gap-2 pt-2 font-medium text-amber-600">
              <Circle className="h-5 w-5" /> Stopped
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status?: string }) {
  if (status === "error") return <XCircle className="h-4 w-4 text-red-600 mt-0.5" />;
  if (status === "done" || status === "success")
    return <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />;
  return <Loader2 className="h-4 w-4 animate-spin text-primary mt-0.5" />;
}

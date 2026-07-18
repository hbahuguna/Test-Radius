import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle, Loader2, Circle, Bot } from "lucide-react";

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
  thoughts: string[];
  screenshot: string | null;
  status: "idle" | "running" | "done" | "failed" | "stopped";
  success?: boolean | null;
}

export function LiveProgress({ steps, thoughts, screenshot, status, success }: LiveProgressProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Auto-scroll the reasoning panel to the bottom unless the user has scrolled up.
  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [thoughts, stickToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Consider "at bottom" within 40px; resume auto-scroll when reached.
    setStickToBottom(distanceFromBottom < 40);
  };

  // Join all reasoning deltas into one flowing block.
  const reasoningText = thoughts.join("");

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

      {/* Steps */}
      {(steps.length > 0 || status !== "idle") && (
        <div className="space-y-2 max-h-[640px] overflow-y-auto">
          {steps.length === 0 && status !== "running" && (
            <p className="text-sm text-muted-foreground">Run steps will appear here.</p>
          )}
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <StatusIcon status={s.status} />
              <div>
                <span className="font-medium">
                  Step {s.step ?? i + 1}
                  {s.total ? `/${s.total}` : ""}:
                </span>{" "}
                <span className="text-muted-foreground">
                  {s.action}
                  {s.target ? ` "${s.target}"` : ""}
                </span>
              </div>
            </div>
          ))}
          {status === "done" && (
            <div className="flex items-center gap-2 pt-2 font-medium">
              {success ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-600" /> Completed — assertions passed
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-red-600" /> Completed — assertions failed
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
              <Circle className="h-5 w-5" /> Run stopped
            </div>
          )}
        </div>
      )}

      {/* Model live reasoning */}
      {(thoughts.length > 0 || status === "running") && (
        <div className="rounded-lg border border-border/40 bg-muted/30 p-3">
          <div className="flex items-center gap-2 mb-2 text-sm font-medium text-muted-foreground">
            <Bot className="h-4 w-4" /> Model reasoning
          </div>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="max-h-[280px] overflow-y-auto text-sm font-mono whitespace-pre-wrap break-words"
          >
            {reasoningText.length === 0 && status === "running" ? (
              <span className="text-muted-foreground">Thinking…</span>
            ) : (
              <p className="text-foreground/90">{reasoningText}</p>
            )}
          </div>
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

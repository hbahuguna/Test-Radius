import { useEffect, useRef } from "react";
import { StepMessage } from "./StepMessage";
import { UserMessage } from "./UserMessage";
import type { AgentStepEvent, AgentLoadingEvent, AgentDoneEvent, AgentErrorEvent } from "@/lib/browser-agent-api";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle, XCircle, AlertCircle } from "lucide-react";

export interface UserMessageEvent {
  event: "user_message";
  message: string;
  timestamp: string;
}

type ChatEvent = AgentStepEvent | AgentLoadingEvent | AgentDoneEvent | AgentErrorEvent | UserMessageEvent;

interface AgentChatPanelProps {
  steps: ChatEvent[];
  status: "idle" | "running" | "completed" | "failed" | "stopped";
}

export function AgentChatPanel({ steps, status }: AgentChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps.length]);

  const latestStep = steps.filter((e) => e.event === "step" || e.event === "loading").pop();

  return (
    <div className="flex flex-col h-full">
      <div
        ref={scrollRef}
        className="flex-1 min-w-0 overflow-x-hidden overflow-y-auto space-y-4 p-4"
      >
        {steps.length === 0 && status === "idle" && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">Start a run to see agent activity</p>
          </div>
        )}

        {steps.map((event, index) => {
          if (event.event === "step" || event.event === "loading") {
            return (
              <StepMessage
                key={`step-${event.step_number}`}
                event={event}
                isLatest={event === latestStep && status === "running"}
              />
            );
          }

          if (event.event === "user_message") {
            return (
              <UserMessage
                key={`user-msg-${index}`}
                message={event.message}
                timestamp={event.timestamp}
              />
            );
          }

          if (event.event === "done") {
            return (
              <Card key="done" className="rounded-xl border-green-500/30 bg-green-500/5">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    {event.success ? (
                      <CheckCircle className="h-5 w-5 text-green-500" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-500" />
                    )}
                    <span className="font-medium">
                      {event.success ? "Task Completed" : "Task Failed"}
                    </span>
                  </div>
                  {event.message && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {event.message}
                    </p>
                  )}
                  {event.duration && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Duration: {event.duration.toFixed(1)}s
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          }

          if (event.event === "error") {
            return (
              <Card key="error" className="rounded-xl border-red-500/30 bg-red-500/5">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 text-red-500" />
                    <span className="font-medium text-red-600">Error</span>
                  </div>
                  <p className="mt-2 text-sm text-red-600/80 font-mono">
                    {event.message}
                  </p>
                </CardContent>
              </Card>
            );
          }

          return null;
        })}

        {status === "running" && steps.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm">Starting agent...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

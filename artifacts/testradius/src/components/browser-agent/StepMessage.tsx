import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { AgentReasoning } from "./AgentReasoning";
import type { AgentStepEvent, AgentLoadingEvent } from "@/lib/browser-agent-api";

interface StepMessageProps {
  event: AgentStepEvent | AgentLoadingEvent;
  isLatest?: boolean;
}

export function StepMessage({ event, isLatest }: StepMessageProps) {
  const { step_number, model_output, screenshot, url, title } = event;

  const actions = model_output?.actions || [];
  const evaluation = model_output?.evaluation_previous_goal;
  const memory = model_output?.memory;
  const nextGoal = model_output?.next_goal;
  const thinking = model_output?.thinking;

  return (
    <Card className={`rounded-xl border transition-all ${isLatest ? "border-primary/50 shadow-md" : "border-border"}`}>
      <CardContent className="p-4">
        {/* Step Header */}
        <div className="flex items-center gap-2 mb-3">
          <Badge variant={isLatest ? "default" : "secondary"} className="text-xs">
            Step {step_number}
          </Badge>
          {url && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {title || url}
            </span>
          )}
          {isLatest && (
            <Loader2 className="h-3 w-3 animate-spin text-primary ml-auto" />
          )}
        </div>

        {/* Screenshot */}
        {screenshot && screenshot.length > 300 && (
          <div className="mb-3 rounded-lg overflow-hidden border border-border/50">
            <img
              src={screenshot.startsWith("data:") ? screenshot : `data:image/jpeg;base64,${screenshot}`}
              alt={`Step ${step_number} screenshot`}
              className="w-full h-auto object-contain max-h-[300px]"
            />
          </div>
        )}

        {/* Evaluation, Memory, Next Goal — shown via AgentReasoning below */}

        {/* Actions */}
        {actions.length > 0 && (
          <div className="space-y-1">
            {actions.map((action, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-sm bg-muted/50 rounded-lg px-3 py-2"
              >
                <ChevronRight className="h-3 w-3 text-primary shrink-0" />
                <span className="font-mono text-xs">{action.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Agent Reasoning (collapsible) */}
        <div className="mt-3">
          <AgentReasoning
            thinking={thinking ?? null}
            evaluation={evaluation ?? null}
            memory={memory ?? null}
            nextGoal={nextGoal ?? null}
          />
        </div>
      </CardContent>
    </Card>
  );
}

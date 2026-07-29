import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

interface AgentReasoningProps {
  thinking: string | null;
  evaluation: string | null;
  memory: string | null;
  nextGoal: string | null;
}

export function AgentReasoning({
  thinking,
  evaluation,
  memory,
  nextGoal,
}: AgentReasoningProps) {
  const [expanded, setExpanded] = useState(false);

  const hasContent = thinking || evaluation || memory || nextGoal;
  if (!hasContent) return null;

  return (
    <Card className="rounded-xl border-border/50 bg-muted/30">
      <CardContent className="p-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full text-left"
        >
          <Brain className="h-4 w-4 text-primary shrink-0" />
          <span className="text-xs font-medium text-muted-foreground">
            Agent Reasoning
          </span>
          <span className="ml-auto text-muted-foreground">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        </button>

        {expanded && (
          <div className="mt-3 space-y-2 text-xs">
            {thinking && (
              <div>
                <span className="font-medium text-muted-foreground">Thinking:</span>
                <p className="mt-1 text-foreground/80 whitespace-pre-wrap">
                  {thinking}
                </p>
              </div>
            )}
            {evaluation && (
              <div>
                <span className="font-medium text-muted-foreground">Evaluation:</span>
                <p className="mt-1 text-foreground/80">{evaluation}</p>
              </div>
            )}
            {memory && (
              <div>
                <span className="font-medium text-muted-foreground">Memory:</span>
                <p className="mt-1 text-foreground/80">{memory}</p>
              </div>
            )}
            {nextGoal && (
              <div>
                <span className="font-medium text-primary">Next Goal:</span>
                <p className="mt-1 text-foreground/80">{nextGoal}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

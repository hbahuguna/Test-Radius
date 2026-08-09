import { Card, CardContent } from "@/components/ui/card";
import { User } from "lucide-react";

interface UserMessageProps {
  message: string;
  timestamp?: string;
}

export function UserMessage({ message, timestamp }: UserMessageProps) {
  return (
    <Card className="rounded-xl border-blue-500/30 bg-blue-500/5">
      <CardContent className="p-4">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/10">
            <User className="h-3 w-3 text-blue-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-blue-600">You</p>
            <p className="mt-1 text-sm text-foreground whitespace-pre-wrap break-words">
              {message}
            </p>
          </div>
          {timestamp && (
            <span className="text-xs text-muted-foreground shrink-0">
              {timestamp}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

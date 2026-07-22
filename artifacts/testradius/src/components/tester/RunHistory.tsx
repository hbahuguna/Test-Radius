import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Clock, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { type RunHistoryItem } from "@/lib/agentic-api";

interface RunHistoryProps {
  runs: RunHistoryItem[];
  loading?: boolean;
}

export function RunHistory({ runs, loading }: RunHistoryProps) {
  const [expandedError, setExpandedError] = useState<string | null>(null);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  }
  if (!(runs?.length ?? 0) > 0) {
    return <p className="text-sm text-muted-foreground">No runs yet. Run your first test above.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Credits</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <>
            <TableRow key={r.id}>
              <TableCell className="text-muted-foreground text-sm">
                {new Date(r.createdAt).toLocaleString()}
              </TableCell>
              <TableCell className="max-w-[200px] truncate" title={r.url}>
                {r.url}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{r.modelUsed}</Badge>
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-1">
                  {r.status === "running" ? (
                    <Clock className="h-4 w-4 text-amber-500" />
                  ) : r.success ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : r.success === false ? (
                    <XCircle className="h-4 w-4 text-red-600" />
                  ) : (
                    <Clock className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span className="capitalize text-sm">{r.status}</span>
                  {r.error && r.success === false && (
                    <button
                      onClick={() => setExpandedError(expandedError === r.id ? null : r.id)}
                      className="ml-1 text-destructive hover:text-destructive/80"
                      title="Show error details"
                    >
                      {expandedError === r.id ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-sm">{r.creditsUsed || (r.modelUsed === "built-in" ? 1 : 0)}</TableCell>
            </TableRow>
            {expandedError === r.id && r.error && (
              <TableRow key={`${r.id}-error`}>
                <TableCell colSpan={5} className="p-0">
                  <div className="mx-4 mb-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                      <p className="text-sm text-destructive/80 font-mono whitespace-pre-wrap break-words">
                        {r.error}
                      </p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </>
        ))}
      </TableBody>
    </Table>
  );
}

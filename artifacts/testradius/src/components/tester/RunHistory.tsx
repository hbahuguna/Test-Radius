import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Clock } from "lucide-react";
import { type RunHistoryItem } from "@/lib/agentic-api";

interface RunHistoryProps {
  runs: RunHistoryItem[];
  loading?: boolean;
}

export function RunHistory({ runs, loading }: RunHistoryProps) {
  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  }
  if (runs.length === 0) {
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
              </span>
            </TableCell>
            <TableCell className="text-sm">{r.creditsUsed || (r.modelUsed === "built-in" ? 1 : 0)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

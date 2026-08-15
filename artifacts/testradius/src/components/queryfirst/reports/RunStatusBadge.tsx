import { Badge } from "@/components/ui/badge";

export function RunStatusBadge({ status }: { status: string }) {
  if (status === "passed") {
    return <Badge className="bg-green-500/15 text-green-500 border-green-500/30">PASS</Badge>;
  }
  if (status === "failed") {
    return <Badge className="bg-red-500/15 text-red-500 border-red-500/30">FAIL</Badge>;
  }
  return <Badge className="bg-zinc-500/15 text-zinc-400 border-zinc-500/30">{status.toUpperCase()}</Badge>;
}

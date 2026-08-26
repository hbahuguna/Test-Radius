import { Badge } from "@/components/ui/badge";

export function RunStatusBadge({ status }: { status: string }) {
  if (status === "passed") {
    return <Badge className="bg-green-500/20 text-green-300 border-green-500/30">PASS</Badge>;
  }
  if (status === "failed") {
    return <Badge className="bg-red-500/20 text-red-300 border-red-500/30">FAIL</Badge>;
  }
  return <Badge className="bg-zinc-500/15 text-zinc-300 border-zinc-500/30">{status.toUpperCase()}</Badge>;
}

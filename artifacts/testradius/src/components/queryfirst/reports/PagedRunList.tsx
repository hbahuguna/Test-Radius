import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface PagedRunListProps<T> {
  rows: T[];
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  renderRow: (row: T) => ReactNode;
  rowKey: (row: T) => string | number;
  emptyText: string;
}

export function PagedRunList<T>({
  rows,
  hasMore,
  loading,
  onLoadMore,
  renderRow,
  rowKey,
  emptyText,
}: PagedRunListProps<T>) {
  if (rows.length === 0) {
    return loading ? (
      <p className="text-xs text-muted-foreground">Loading…</p>
    ) : (
      <p className="text-xs text-muted-foreground">{emptyText}</p>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={rowKey(row)}>{renderRow(row)}</div>
      ))}
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="text-xs h-8 w-full"
          onClick={onLoadMore}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : null}
          Load more
        </Button>
      )}
    </div>
  );
}

import { useState } from "react";

export interface BucketItem {
  id: number;
  label: string;
  sublabel?: string;
}

export interface BucketMember {
  id: number;
  parallel: boolean;
}

interface BucketsEditorProps {
  allItems: BucketItem[];
  members: BucketMember[];
  onChange: (members: BucketMember[]) => void;
  itemNoun: string;
}

export function BucketsEditor({ allItems, members, onChange, itemNoun }: BucketsEditorProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropZone, setDropZone] = useState<"sequential" | "parallel" | "pool" | null>(null);

  const memberIds = new Set(members.map((m) => m.id));
  const pool = allItems.filter((item) => !memberIds.has(item.id));
  const seqMembers = members.filter((m) => !m.parallel);
  const parMembers = members.filter((m) => m.parallel);

  const itemLabel = (id: number) => allItems.find((i) => i.id === id)?.label ?? `#${id}`;
  const itemSublabel = (id: number) => allItems.find((i) => i.id === id)?.sublabel;

  const moveTo = (id: number, parallel: boolean, insertBefore?: number) => {
    const without = members.filter((m) => m.id !== id);
    if (parallel) {
      onChange([...without, { id, parallel: true }]);
      return;
    }
    if (insertBefore !== undefined) {
      const idx = without.findIndex((m) => m.id === insertBefore && !m.parallel);
      if (idx >= 0) {
        without.splice(idx, 0, { id, parallel: false });
        onChange(without);
        return;
      }
    }
    onChange([...without, { id, parallel: false }]);
  };

  const removeFromBucket = (id: number) => {
    onChange(members.filter((m) => m.id !== id));
  };

  const handleDragStart = (id: number) => {
    setDragId(id);
  };

  const handleDropOnZone = (parallel: boolean) => {
    if (dragId === null) return;
    moveTo(dragId, parallel);
    setDragId(null);
    setDropZone(null);
  };

  const handleDropOnItem = (parallel: boolean, insertBefore: number) => {
    if (dragId === null) return;
    if (parallel) {
      moveTo(dragId, true);
    } else {
      moveTo(dragId, false, insertBefore);
    }
    setDragId(null);
    setDropZone(null);
  };

  const draggableProps = (id: number) => ({
    draggable: true,
    onDragStart: () => handleDragStart(id),
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); },
    onDragEnd: () => { setDragId(null); setDropZone(null); },
  });

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {/* Available pool */}
        <div
          className={`rounded-lg border p-2 space-y-1 min-h-[80px] ${dropZone === "pool" ? "border-primary bg-primary/5" : "border-zinc-800 bg-zinc-950/50"}`}
          onDragOver={(e) => { e.preventDefault(); setDropZone("pool"); }}
          onDrop={(e) => { e.preventDefault(); if (dragId !== null) removeFromBucket(dragId); setDragId(null); setDropZone(null); }}
        >
          <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Available {itemNoun}</p>
          {pool.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 italic py-2 text-center">Drag {itemNoun} into a bucket</p>
          ) : (
            pool.map((item) => (
              <div
                key={item.id}
                {...draggableProps(item.id)}
                className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-zinc-700 bg-zinc-800/50 cursor-grab hover:border-zinc-600 hover:bg-zinc-800"
              >
                <span className="font-mono text-[10px] text-muted-foreground">#{item.id}</span>
                <span className="truncate">{item.label}</span>
                {item.sublabel && <span className="text-[10px] text-muted-foreground ml-auto">{item.sublabel}</span>}
              </div>
            ))
          )}
        </div>

        {/* Sequential bucket */}
        <div
          className={`rounded-lg border p-2 space-y-1 min-h-[80px] ${dropZone === "sequential" ? "border-amber-500/50 bg-amber-500/5" : "border-amber-800/40 bg-amber-950/10"}`}
          onDragOver={(e) => { e.preventDefault(); setDropZone("sequential"); }}
          onDrop={(e) => { e.preventDefault(); handleDropOnZone(false); }}
        >
          <p className="text-[11px] text-amber-500/80 font-medium uppercase tracking-wide">Sequential (in order)</p>
          {seqMembers.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 italic py-2 text-center">Drop here to run one-by-one</p>
          ) : (
            seqMembers.map((m) => (
              <div
                key={m.id}
                {...draggableProps(m.id)}
                onDrop={(e) => { e.stopPropagation(); e.preventDefault(); handleDropOnItem(false, m.id); }}
                className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-amber-700/30 bg-amber-900/20 cursor-grab hover:border-amber-600/50"
              >
                <span className="font-mono text-[10px] text-muted-foreground">#{m.id}</span>
                <span className="truncate">{itemLabel(m.id)}</span>
                {itemSublabel(m.id) && <span className="text-[10px] text-muted-foreground">{itemSublabel(m.id)}</span>}
                <button
                  onClick={() => moveTo(m.id, true)}
                  className="ml-auto text-[10px] text-blue-400 hover:text-blue-300 px-1"
                  title="Move to Parallel"
                >→∥</button>
                <button
                  onClick={() => removeFromBucket(m.id)}
                  className="text-[10px] text-muted-foreground hover:text-red-400"
                  title="Remove"
                >✕</button>
              </div>
            ))
          )}
        </div>

        {/* Parallel bucket */}
        <div
          className={`rounded-lg border p-2 space-y-1 min-h-[80px] ${dropZone === "parallel" ? "border-blue-500/50 bg-blue-500/5" : "border-blue-800/40 bg-blue-950/10"}`}
          onDragOver={(e) => { e.preventDefault(); setDropZone("parallel"); }}
          onDrop={(e) => { e.preventDefault(); handleDropOnZone(true); }}
        >
          <p className="text-[11px] text-blue-500/80 font-medium uppercase tracking-wide">Parallel (concurrent)</p>
          {parMembers.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60 italic py-2 text-center">Drop here to run at the same time</p>
          ) : (
            parMembers.map((m) => (
              <div
                key={m.id}
                {...draggableProps(m.id)}
                className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-blue-700/30 bg-blue-900/20 cursor-grab hover:border-blue-600/50"
              >
                <span className="font-mono text-[10px] text-muted-foreground">#{m.id}</span>
                <span className="truncate">{itemLabel(m.id)}</span>
                {itemSublabel(m.id) && <span className="text-[10px] text-muted-foreground">{itemSublabel(m.id)}</span>}
                <button
                  onClick={() => moveTo(m.id, false)}
                  className="ml-auto text-[10px] text-amber-400 hover:text-amber-300 px-1"
                  title="Move to Sequential"
                >→→</button>
                <button
                  onClick={() => removeFromBucket(m.id)}
                  className="text-[10px] text-muted-foreground hover:text-red-400"
                  title="Remove"
                >✕</button>
              </div>
            ))
          )}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Drag {itemNoun} between buckets to choose how they run. Sequential {itemNoun} run one-by-one in order; Parallel ones run concurrently.
      </p>
    </div>
  );
}
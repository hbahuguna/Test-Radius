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

type DragKind = "pool" | "member" | "group";

type DragState =
  | { kind: "pool" | "member"; id: number }
  | { kind: "group"; anchorId: number }
  | null;

interface BucketsEditorProps {
  allItems: BucketItem[];
  members: BucketMember[];
  onChange: (members: BucketMember[]) => void;
  itemNoun: string;
}

/**
 * Partition ordered members into execution groups. A run of consecutive
 * parallel members is a single parallel group; a sequential member is its own
 * group of one. Groups are the units of the sequence.
 */
export function partitionMembers(members: readonly BucketMember[]): BucketMember[][] {
  const groups: BucketMember[][] = [];
  let parallelRun: BucketMember[] | null = null;
  for (const m of members) {
    if (m.parallel) {
      (parallelRun ??= []).push(m);
    } else {
      if (parallelRun !== null) groups.push(parallelRun);
      parallelRun = null;
      groups.push([m]);
    }
  }
  if (parallelRun !== null) groups.push(parallelRun);
  return groups;
}

function groupByAnchor(groups: BucketMember[][], anchorId: number): number {
  return groups.findIndex((g) => g.some((m) => m.id === anchorId));
}

/** Add `memberId` into the group anchored at `anchorId`. Adding a second member
 * to a sequential group turns both into a parallel group. */
function addToGroup(members: BucketMember[], memberId: number, anchorId: number): BucketMember[] {
  const without = members.filter((m) => m.id !== memberId);
  const groups = partitionMembers(without);
  const idx = groupByAnchor(groups, anchorId);
  if (idx < 0) return [...without, { id: memberId, parallel: false }];
  const target = groups[idx];
  const updated = groups.flatMap((g, i) => {
    if (i !== idx) return g;
    if (target[0].parallel) return [...g, { id: memberId, parallel: true }];
    return [
      { id: g[0].id, parallel: true },
      { id: memberId, parallel: true },
    ];
  });
  return updated;
}

function appendSequential(members: BucketMember[], memberId: number): BucketMember[] {
  return [...members.filter((m) => m.id !== memberId), { id: memberId, parallel: false }];
}

function removeMember(members: BucketMember[], memberId: number): BucketMember[] {
  return members.filter((m) => m.id !== memberId);
}

function moveGroupBefore(members: BucketMember[], anchorId: number, targetAnchorId: number): BucketMember[] {
  const groups = partitionMembers(members);
  const fromIdx = groupByAnchor(groups, anchorId);
  const toIdx = groupByAnchor(groups, targetAnchorId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return members;
  const [moved] = groups.splice(fromIdx, 1);
  const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
  groups.splice(insertAt, 0, moved);
  return groups.flat();
}

function moveGroupBy(members: BucketMember[], anchorId: number, delta: number): BucketMember[] {
  const groups = partitionMembers(members);
  const idx = groupByAnchor(groups, anchorId);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= groups.length) return members;
  const [moved] = groups.splice(idx, 1);
  groups.splice(next, 0, moved);
  return groups.flat();
}

function splitParallelGroup(members: BucketMember[], anchorId: number): BucketMember[] {
  const groups = partitionMembers(members);
  const idx = groupByAnchor(groups, anchorId);
  if (idx < 0) return members;
  const group = groups[idx];
  if (group.length < 2) return members;
  groups.splice(idx, 1, ...group.map((m) => [{ id: m.id, parallel: false }]));
  return groups.flat();
}

/** Read-only rendering of a sequence of groups, used for saved suites/trains. */
export function MemberGroupChips({
  groups,
  getLabel,
  getSublabel,
}: {
  groups: BucketMember[][];
  getLabel: (id: number) => string;
  getSublabel?: (id: number) => string | undefined;
}) {
  if (groups.length === 0) return <span className="text-xs text-muted-foreground">No members assigned</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {groups.map((g, gi) => {
        const parallel = g[0].parallel;
        return (
          <span
            key={gi}
            className={`inline-flex items-center rounded border px-1.5 py-0.5 ${
              parallel ? "border-blue-700/40 bg-blue-900/15" : "border-amber-700/40 bg-amber-900/15"
            }`}
            title={parallel ? "Parallel group — runs together as one unit" : "Sequential step — runs alone"}
          >
            <span className={`mr-1 text-[10px] font-semibold uppercase tracking-wide ${parallel ? "text-blue-400" : "text-amber-400"}`}>
              {gi + 1}
            </span>
            {g.map((m) => (
              <span key={m.id} className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${parallel ? "text-blue-300" : "text-amber-300"}`}>
                <span>{parallel ? "\u22a5" : "\u2192"}</span>
                <span>{getLabel(m.id)}</span>
                {getSublabel?.(m.id) && <span className="text-[10px] text-muted-foreground">{getSublabel(m.id)}</span>}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}

export function BucketsEditor({ allItems, members, onChange, itemNoun }: BucketsEditorProps) {
  const [drag, setDrag] = useState<DragState>(null);
  const [overZone, setOverZone] = useState<string | null>(null);

  const groups = partitionMembers(members);
  const memberIds = new Set(members.map((m) => m.id));
  const pool = allItems.filter((item) => !memberIds.has(item.id));

  const itemLabel = (id: number) => allItems.find((i) => i.id === id)?.label ?? `#${id}`;
  const itemSublabel = (id: number) => allItems.find((i) => i.id === id)?.sublabel;

  const emit = (next: BucketMember[]) => onChange(next);

  const draggableProps = (state: Exclude<DragState, null>) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDrag(state);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      setDrag(null);
      setOverZone(null);
    },
  });

  const zoneProps = (zone: string, accept: DragKind[], onDrop: () => void) => ({
    onDragOver: (e: React.DragEvent) => {
      if (drag && accept.includes(drag.kind)) {
        e.preventDefault();
        setOverZone(zone);
      }
    },
    onDragLeave: () => {
      if (overZone === zone) setOverZone(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (drag && accept.includes(drag.kind)) onDrop();
      setDrag(null);
      setOverZone(null);
    },
  });

  return (
    <div className="space-y-3">
      {/* Available pool */}
      <div
        {...zoneProps("pool", ["member"], () => { if (drag && drag.kind === "member") emit(removeMember(members, drag.id)); })}
        className={`rounded-lg border p-2 space-y-1 min-h-[56px] ${overZone === "pool" ? "border-primary/70 bg-primary/5" : "border-zinc-800 bg-zinc-950/50"}`}
      >
        <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Available {itemNoun}s</p>
        {pool.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60 italic py-2 text-center">All {itemNoun}s are in the sequence</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {pool.map((item) => (
              <div
                key={item.id}
                {...draggableProps({ kind: "pool", id: item.id })}
                className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-zinc-700 bg-zinc-800/50 cursor-grab hover:border-zinc-600 hover:bg-zinc-800"
              >
                <span className="font-mono text-[10px] text-muted-foreground">#{item.id}</span>
                <span className="truncate">{item.label}</span>
                {item.sublabel && <span className="text-[10px] text-muted-foreground ml-auto">{item.sublabel}</span>}
              </div>
            ))}
          </div>
        )}
        {overZone === "pool" && drag?.kind === "member" && (
          <p className="text-[11px] text-primary italic pt-1">Drop to remove from the sequence</p>
        )}
      </div>

      {/* The sequence */}
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Sequence</p>
        {groups.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-700 p-3 text-center text-[11px] text-muted-foreground/60 italic">
            Sequence is empty — drag {itemNoun}s in
          </div>
        )}
        {groups.map((g, gi) => {
          const parallel = g[0].parallel;
          const anchorId = g[0].id;
          return (
            <div
              key={anchorId}
              {...zoneProps(`group-${anchorId}`, ["member", "pool"], () => { if (drag && drag.kind !== "group") emit(addToGroup(members, drag.id, anchorId)); })}
              className={`rounded-lg border p-2 space-y-2 transition-colors ${
                parallel
                  ? overZone === `group-${anchorId}`
                    ? "border-blue-500/70 bg-blue-500/10"
                    : "border-blue-800/40 bg-blue-950/10"
                  : overZone === `group-${anchorId}`
                    ? "border-amber-500/70 bg-amber-500/10"
                    : "border-amber-800/40 bg-amber-950/10"
              }`}
            >
              {/* Header: drag handle for reordering, badge, actions */}
              <div
                {...draggableProps({ kind: "group", anchorId })}
                {...zoneProps(`ghead-${anchorId}`, ["group"], () => { if (drag && drag.kind === "group") emit(moveGroupBefore(members, drag.anchorId, anchorId)); })}
                className="flex items-center gap-2 cursor-grab select-none"
                title="Drag to reorder this group in the sequence"
              >
                <span className="text-[10px] font-mono text-muted-foreground">G{gi + 1}</span>
                <span
                  className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                    parallel ? "bg-blue-500/15 text-blue-400" : "bg-amber-500/15 text-amber-400"
                  }`}
                >
                  {parallel ? "\u22a5 Parallel" : "\u2192 Sequential"}
                  <span className="text-muted-foreground font-normal normal-case">({g.length})</span>
                </span>
                <span className="ml-auto flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => emit(moveGroupBy(members, anchorId, -1))}
                    disabled={gi === 0}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-25 px-1 text-xs"
                    title="Move group up"
                  >
                    {"\u25b2"}
                  </button>
                  <button
                    type="button"
                    onClick={() => emit(moveGroupBy(members, anchorId, 1))}
                    disabled={gi === groups.length - 1}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-25 px-1 text-xs"
                    title="Move group down"
                  >
                    {"\u25bc"}
                  </button>
                  {parallel && g.length > 1 && (
                    <button
                      type="button"
                      onClick={() => emit(splitParallelGroup(members, anchorId))}
                      className="text-[10px] text-blue-400 hover:text-blue-300 px-1.5"
                      title="Split into sequential steps"
                    >
                      split
                    </button>
                  )}
                </span>
              </div>

              {/* Body: drop zone for members/pool */}
              <div className="flex flex-wrap gap-1.5">
                {g.map((m) => (
                  <div
                    key={m.id}
                    {...draggableProps({ kind: "member", id: m.id })}
                    className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-zinc-700 bg-zinc-800/50 cursor-grab hover:border-zinc-600"
                  >
                    <span className="font-mono text-[10px] text-muted-foreground">#{m.id}</span>
                    <span className="truncate">{itemLabel(m.id)}</span>
                    {itemSublabel(m.id) && <span className="text-[10px] text-muted-foreground">{itemSublabel(m.id)}</span>}
                    <button
                      type="button"
                      onClick={() => emit(removeMember(members, m.id))}
                      className="text-[10px] text-muted-foreground hover:text-red-400 ml-1"
                      title="Remove from sequence"
                    >
                      {"\u2715"}
                    </button>
                  </div>
                ))}
              </div>
              {overZone === `group-${anchorId}` && drag?.kind !== "group" && (
                <p className={`text-[11px] italic pt-1 ${parallel ? "text-blue-400" : "text-amber-400"}`}>
                  Drop to add to this {parallel ? "parallel group" : "step"}
                </p>
              )}
            </div>
          );
        })}

        {/* End-of-sequence drop zone: append a new sequential step */}
        <div
          {...zoneProps("end", ["pool", "member"], () => { if (drag && drag.kind !== "group") emit(appendSequential(members, drag.id)); })}
          className={`rounded-lg border border-dashed p-2 text-center text-[11px] transition-colors ${
            overZone === "end" ? "border-amber-500/70 bg-amber-500/10 text-amber-300" : "border-zinc-700 text-muted-foreground/60"
          }`}
        >
          {overZone === "end" ? "Drop to add a new sequential step at the end" : `Drop here to add a new sequential step at the end`}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        A {itemNoun} list runs as a sequence of groups. A step with one {itemNoun} runs alone; a group with two or more runs in parallel as
        one unit, then the next group starts. Drag {itemNoun}s between groups to group them, and drag group headers to reorder the sequence.
      </p>
    </div>
  );
}

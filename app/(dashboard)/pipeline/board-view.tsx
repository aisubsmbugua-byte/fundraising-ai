"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { STAGES, type Prospect, type Stage } from "@/lib/prospects";
import { spacing, colors } from "@/lib/ui";
import { moveProspectStage } from "./actions";
import ProspectCard from "./prospect-card";

// Props are plain, serializable data (no Map, no functions) since
// this crosses the server/client boundary from the page's data
// fetch -- daysInStage in particular has to be precomputed there
// rather than passed as a function.
export default function BoardView({
  prospects,
  tierByProspect,
  daysInStageByProspect,
}: {
  prospects: Prospect[];
  tierByProspect: Record<string, number>;
  daysInStageByProspect: Record<string, number>;
}) {
  const [items, setItems] = useState(prospects);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // A small movement threshold so a plain click still opens the
  // prospect (ProspectCard is a Link) instead of every click being
  // swallowed as a drag attempt.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const byStage = new Map<string, Prospect[]>();
  for (const s of STAGES) byStage.set(s.value, []);
  for (const p of items) byStage.get(p.stage)?.push(p);

  const activeProspect = items.find((p) => p.id === activeId);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const prospectId = active.id as string;
    const toStage = over.id as Stage;
    const prospect = items.find((p) => p.id === prospectId);
    if (!prospect || prospect.stage === toStage) return;

    const fromStage = prospect.stage;
    setItems((prev) => prev.map((p) => (p.id === prospectId ? { ...p, stage: toStage } : p)));

    startTransition(async () => {
      try {
        await moveProspectStage(prospectId, fromStage, toStage);
      } catch {
        // Someone else moved it since the page loaded -- revert the
        // optimistic move rather than leave the board showing
        // something the database doesn't actually have.
        setItems((prev) => prev.map((p) => (p.id === prospectId ? { ...p, stage: fromStage } : p)));
      }
    });
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div style={{ overflowX: "auto", marginTop: spacing.lg, paddingBottom: 16 }}>
        <div
          style={{
            display: "grid",
            // The 140px floor (not "auto") is load-bearing: a grid
            // track's default min size is its content's intrinsic
            // width, so without an explicit fixed floor here, one
            // long unwrapped prospect name blows a column out past
            // its fair 1/6 share.
            gridTemplateColumns: "repeat(6, minmax(140px, 1fr))",
            gap: 10,
            minWidth: 900,
          }}
        >
          {STAGES.map((s) => (
            <Column
              key={s.value}
              stage={s.value}
              label={s.label}
              prospects={byStage.get(s.value) ?? []}
              tierByProspect={tierByProspect}
              daysInStageByProspect={daysInStageByProspect}
            />
          ))}
        </div>
      </div>
      <DragOverlay>
        {activeProspect && (
          <ProspectCard
            prospect={activeProspect}
            tier={tierByProspect[activeProspect.id]}
            daysInStage={daysInStageByProspect[activeProspect.id] ?? 0}
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  stage,
  label,
  prospects,
  tierByProspect,
  daysInStageByProspect,
}: {
  stage: string;
  label: string;
  prospects: Prospect[];
  tierByProspect: Record<string, number>;
  daysInStageByProspect: Record<string, number>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  return (
    <div
      ref={setNodeRef}
      style={{
        minWidth: 0,
        borderRadius: 8,
        padding: 4,
        margin: -4,
        background: isOver ? colors.bgSubtle : "transparent",
        outline: isOver ? `2px dashed ${colors.borderStrong}` : "2px dashed transparent",
        transition: "background 0.15s ease, outline-color 0.15s ease",
      }}
    >
      <Link
        href={`/pipeline?stage=${stage}`}
        style={{ fontSize: 13, fontWeight: 600, color: colors.text, textDecoration: "none" }}
      >
        {label} ({prospects.length})
      </Link>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6, marginTop: spacing.sm, minWidth: 0 }}>
        {prospects.map((p) => (
          <DraggableCard
            key={p.id}
            prospect={p}
            tier={tierByProspect[p.id]}
            daysInStage={daysInStageByProspect[p.id] ?? 0}
          />
        ))}
        {prospects.length === 0 && <p style={{ fontSize: 12, color: colors.textFaint }}>No prospects</p>}
      </div>
    </div>
  );
}

function DraggableCard({
  prospect,
  tier,
  daysInStage,
}: {
  prospect: Prospect;
  tier?: number;
  daysInStage: number;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: prospect.id });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab" }}
    >
      <ProspectCard prospect={prospect} tier={tier} daysInStage={daysInStage} />
    </div>
  );
}

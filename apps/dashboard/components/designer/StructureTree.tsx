"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ChannelDesign, ChannelKind } from "@monarch/schemas";
import { isLocalId } from "@monarch/shared";
import {
  channelsIn,
  orderedCategories,
  type DesignerAction,
  type DesignerState,
} from "./designer-state";

/**
 * The design canvas: a Discord-like structure tree with drag-and-drop.
 * Category blocks sort vertically; channels sort within and across
 * categories (including a top-level "no category" zone).
 */

const ROOT = "__root__";
const chId = (id: string) => `ch:${id}`;
const catId = (id: string) => `cat:${id}`;
const dropId = (id: string) => `drop:${id}`;
const parse = (raw: string): { kind: string; id: string } => {
  const [kind = "", ...rest] = raw.split(":");
  return { kind, id: rest.join(":") };
};

export function StructureTree({
  state,
  dispatch,
}: {
  state: DesignerState;
  dispatch: React.Dispatch<DesignerAction>;
}) {
  const design = state.design!;
  const categories = orderedCategories(design);
  const rootChannels = channelsIn(design, undefined);
  const [active, setActive] = useState<{ kind: string; id: string } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const activeChannel = useMemo(
    () => (active?.kind === "ch" ? design.channels.find((c) => c.id === active.id) : undefined),
    [active, design.channels],
  );
  const activeCategory = useMemo(
    () => (active?.kind === "cat" ? design.categories.find((c) => c.id === active.id) : undefined),
    [active, design.categories],
  );

  function containerOf(overRaw: string): { parentId: string | undefined; index: number } | null {
    const over = parse(overRaw);
    if (over.kind === "drop") {
      const parentId = over.id === ROOT ? undefined : over.id;
      return { parentId, index: channelsIn(design, parentId).length };
    }
    if (over.kind === "ch") {
      const target = design.channels.find((c) => c.id === over.id);
      if (!target) return null;
      const siblings = channelsIn(design, target.parentId);
      return { parentId: target.parentId, index: siblings.findIndex((c) => c.id === target.id) };
    }
    if (over.kind === "cat") {
      return { parentId: over.id, index: channelsIn(design, over.id).length };
    }
    return null;
  }

  function onDragStart(e: DragStartEvent) {
    setActive(parse(String(e.active.id)));
    dispatch({ type: "DRAG_BEGIN" });
  }

  function onDragOver(e: DragOverEvent) {
    if (!e.over || active?.kind !== "ch") return;
    const dest = containerOf(String(e.over.id));
    if (!dest) return;
    const current = design.channels.find((c) => c.id === active.id);
    if (!current) return;
    const currentSiblings = channelsIn(design, current.parentId);
    const currentIndex = currentSiblings.findIndex((c) => c.id === active.id);
    if ((current.parentId ?? undefined) === dest.parentId && currentIndex === dest.index) return;
    dispatch({
      type: "MOVE_CHANNEL",
      id: active.id,
      parentId: dest.parentId,
      index: dest.index,
      transient: true,
    });
  }

  function onDragEnd(e: DragEndEvent) {
    if (active?.kind === "cat" && e.over) {
      const over = parse(String(e.over.id));
      if (over.kind === "cat") {
        const index = categories.findIndex((c) => c.id === over.id);
        if (index >= 0) {
          dispatch({ type: "MOVE_CATEGORY", id: active.id, index, transient: true });
        }
      }
    }
    dispatch({ type: "DRAG_COMMIT" });
    setActive(null);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        dispatch({ type: "DRAG_CANCEL" });
        setActive(null);
      }}
    >
      <div className="mx-auto max-w-lg">
        {/* top-level channels */}
        <ChannelZone
          parentId={undefined}
          channels={rootChannels}
          state={state}
          dispatch={dispatch}
          emptyHint={categories.length === 0 ? "No channels yet — add one below." : undefined}
        />

        {/* categories */}
        <SortableContext items={categories.map((c) => catId(c.id))} strategy={verticalListSortingStrategy}>
          {categories.map((cat) => (
            <CategoryBlock key={cat.id} categoryId={cat.id} state={state} dispatch={dispatch} />
          ))}
        </SortableContext>

        {/* add buttons */}
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => dispatch({ type: "ADD_CATEGORY" })}
            className="flex-1 rounded-xl border border-dashed border-ink-600 py-2.5 text-xs text-ink-300 transition hover:border-royal-500/60 hover:text-royal-400"
          >
            + Category
          </button>
          <button
            onClick={() => dispatch({ type: "ADD_CHANNEL", kind: "text" })}
            className="flex-1 rounded-xl border border-dashed border-ink-600 py-2.5 text-xs text-ink-300 transition hover:border-royal-500/60 hover:text-royal-400"
          >
            + Channel
          </button>
        </div>
      </div>

      <DragOverlay>
        {activeChannel && <ChannelRowStatic channel={activeChannel} />}
        {activeCategory && (
          <div className="rounded-lg border border-royal-500/40 bg-ink-850 px-3 py-2 text-[11px] font-semibold tracking-wider text-ink-200 uppercase shadow-xl">
            {activeCategory.name}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

// ── category block ───────────────────────────────────────────────────

function CategoryBlock({
  categoryId,
  state,
  dispatch,
}: {
  categoryId: string;
  state: DesignerState;
  dispatch: React.Dispatch<DesignerAction>;
}) {
  const design = state.design!;
  const cat = design.categories.find((c) => c.id === categoryId)!;
  const channels = channelsIn(design, categoryId);
  const selected = state.selection?.kind === "category" && state.selection.id === categoryId;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: catId(categoryId),
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`mt-4 ${isDragging ? "opacity-40" : ""}`}
    >
      <div
        onClick={() => dispatch({ type: "SELECT", selection: { kind: "category", id: categoryId } })}
        className={`group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 transition ${
          selected ? "bg-royal-500/15" : "hover:bg-ink-800/60"
        }`}
      >
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab text-ink-500 opacity-0 transition group-hover:opacity-100 active:cursor-grabbing"
          title="Drag to reorder category"
          onClick={(e) => e.stopPropagation()}
        >
          <GripIcon />
        </button>
        <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 text-ink-400" fill="currentColor" aria-hidden>
          <path d="M4.5 6l3.5 4 3.5-4h-7z" />
        </svg>
        <span
          className={`flex-1 truncate text-[11px] font-semibold tracking-wider uppercase ${
            selected ? "text-royal-400" : "text-ink-300"
          }`}
        >
          {cat.name}
          {isLocalId(cat.id) && <NewBadge />}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: "ADD_CHANNEL", kind: "text", parentId: categoryId });
          }}
          title="Add channel to this category"
          className="rounded px-1.5 text-sm text-ink-400 opacity-0 transition group-hover:opacity-100 hover:text-royal-400"
        >
          +
        </button>
      </div>

      <ChannelZone parentId={categoryId} channels={channels} state={state} dispatch={dispatch} />
    </div>
  );
}

// ── channel zone (droppable list) ────────────────────────────────────

function ChannelZone({
  parentId,
  channels,
  state,
  dispatch,
  emptyHint,
}: {
  parentId: string | undefined;
  channels: ChannelDesign[];
  state: DesignerState;
  dispatch: React.Dispatch<DesignerAction>;
  emptyHint?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId(parentId ?? ROOT) });

  return (
    <SortableContext items={channels.map((c) => chId(c.id))} strategy={verticalListSortingStrategy}>
      <div
        ref={setNodeRef}
        className={`ml-3 space-y-0.5 rounded-lg py-0.5 pl-2 transition ${
          isOver ? "bg-royal-500/5 ring-1 ring-royal-500/25" : ""
        } ${channels.length === 0 ? "min-h-7" : ""}`}
      >
        {channels.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-ink-500 italic">
            {emptyHint ?? "Drop channels here"}
          </p>
        )}
        {channels.map((ch) => (
          <ChannelRow key={ch.id} channel={ch} state={state} dispatch={dispatch} />
        ))}
      </div>
    </SortableContext>
  );
}

// ── channel row ──────────────────────────────────────────────────────

const CHANNEL_ICONS: Record<ChannelKind, string> = {
  text: "#",
  voice: "🔊",
  announcement: "📣",
  forum: "🗂",
  stage: "🎙",
};

function ChannelRow({
  channel,
  state,
  dispatch,
}: {
  channel: ChannelDesign;
  state: DesignerState;
  dispatch: React.Dispatch<DesignerAction>;
}) {
  const selected = state.selection?.kind === "channel" && state.selection.id === channel.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: chId(channel.id),
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={() => dispatch({ type: "SELECT", selection: { kind: "channel", id: channel.id } })}
      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition ${
        isDragging ? "opacity-30" : ""
      } ${selected ? "bg-royal-500/15" : "hover:bg-ink-800/60"}`}
    >
      <button
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className="cursor-grab text-ink-500 opacity-0 transition group-hover:opacity-100 active:cursor-grabbing"
        title="Drag to move"
      >
        <GripIcon />
      </button>
      <span className={`w-4 text-center text-sm ${selected ? "text-royal-400" : "text-ink-400"}`}>
        {CHANNEL_ICONS[channel.type]}
      </span>
      <span className={`truncate text-[13px] ${selected ? "text-royal-300" : "text-ink-200"}`}>
        {channel.name}
      </span>
      {isLocalId(channel.id) && <NewBadge />}
      {channel.topic && (
        <span className="ml-1 hidden max-w-40 truncate text-[10px] text-ink-500 sm:block">
          {channel.topic}
        </span>
      )}
    </div>
  );
}

function ChannelRowStatic({ channel }: { channel: ChannelDesign }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-royal-500/40 bg-ink-850 px-3 py-1.5 shadow-xl">
      <span className="w-4 text-center text-sm text-ink-400">{CHANNEL_ICONS[channel.type]}</span>
      <span className="text-[13px] text-ink-100">{channel.name}</span>
    </div>
  );
}

function NewBadge() {
  return (
    <span className="ml-1.5 rounded bg-ok-400/15 px-1 py-px align-middle text-[9px] font-semibold tracking-wide text-ok-400 uppercase">
      new
    </span>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <circle cx="5.5" cy="4" r="1.2" />
      <circle cx="10.5" cy="4" r="1.2" />
      <circle cx="5.5" cy="8" r="1.2" />
      <circle cx="10.5" cy="8" r="1.2" />
      <circle cx="5.5" cy="12" r="1.2" />
      <circle cx="10.5" cy="12" r="1.2" />
    </svg>
  );
}

import type { KanbanCard, KanbanColumn } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Envelope = Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown });
const ListData = Schema.Struct({ items: Schema.Array(Schema.Unknown), total: Schema.Int });
const Record = Schema.Struct({ id: Schema.String, title: Schema.String, status: Schema.String });
const Applied = Schema.Struct({ applied: Schema.Literal(true) });
const isEnvelope = Schema.is(Envelope);
const isListData = Schema.is(ListData);
const isRecord = Schema.is(Record);
const isApplied = Schema.is(Applied);
const columns = ["backlog", "todo", "in_progress", "review", "done"] as const;
const issueColumns: Readonly<Record<string, KanbanColumn>> = {
  open: "backlog",
  in_progress: "in_progress",
  resolved: "review",
  closed: "done",
  archived: "done",
};
const taskColumns: Readonly<Record<string, KanbanColumn>> = {
  todo: "todo",
  doing: "in_progress",
  blocked: "in_progress",
  review: "review",
  done: "done",
  cancelled: "done",
};

export function parseGithiveCards(json: string, kind: KanbanCard["kind"]): KanbanCard[] {
  const envelope: unknown = JSON.parse(json);
  if (
    !isEnvelope(envelope) ||
    !isListData(envelope.data) ||
    envelope.data.total !== envelope.data.items.length
  ) {
    throw new Error("Invalid githive list envelope");
  }
  const seen = new Set<string>();
  return envelope.data.items.map((record) => {
    if (
      !isRecord(record) ||
      !/^[0-9a-hjkmnp-tv-z]{26}$/i.test(record.id) ||
      record.title.trim() === ""
    ) {
      throw new Error("Invalid githive record");
    }
    const statusColumns = kind === "issue" ? issueColumns : taskColumns;
    const column = Object.hasOwn(statusColumns, record.status)
      ? statusColumns[record.status]
      : undefined;
    const sourceId = record.id.toLowerCase();
    if (column === undefined || seen.has(sourceId))
      throw new Error("Invalid githive status or duplicate ID");
    seen.add(sourceId);
    return {
      cardId: `${kind}:${sourceId}`,
      sourceId,
      kind,
      title: record.title,
      status: record.status,
      column,
    };
  });
}

export function groupKanbanCards(cards: ReadonlyArray<KanbanCard>, query = "") {
  const needle = query.trim().toLowerCase();
  const sorted = cards
    .filter((card) => card.title.toLowerCase().includes(needle) || card.cardId.includes(needle))
    .sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  return columns.map((column) => ({
    column,
    cards: sorted.filter((card) => card.column === column),
  }));
}

export function kanbanTransitionStatus(card: KanbanCard, target: KanbanColumn): string | null {
  if (card.column === target) return card.status;
  if (card.kind === "issue") {
    if (card.status === "archived") return null;
    if (target === "backlog") return "open";
    if (target === "done") return "closed";
    if (card.status === "open" && target === "in_progress") return "in_progress";
    if (card.status === "in_progress" && target === "review") return "resolved";
    return null;
  }
  if (target === "todo") return "todo";
  if ((card.status === "todo" || card.status === "blocked") && target === "in_progress")
    return "doing";
  if (card.status === "doing" && target === "review") return "review";
  if (card.status === "review" && target === "done") return "done";
  return null;
}

export function isGithiveMoveApplied(json: string): boolean {
  const envelope: unknown = JSON.parse(json);
  return isEnvelope(envelope) && isApplied(envelope.data);
}

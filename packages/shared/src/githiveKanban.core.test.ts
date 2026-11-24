import { describe, expect, it } from "vite-plus/test";
import {
  groupKanbanCards,
  isGithiveMoveApplied,
  kanbanTransitionStatus,
  parseGithiveCards,
} from "./githiveKanban.core.ts";

const id = "01j8xt5e6f7g8h9j0k1a2b3c4d";
const list = (items: ReadonlyArray<unknown>) =>
  JSON.stringify({ ok: true, data: { items, total: items.length } });

describe("githive kanban core", () => {
  it("maps every native status and groups deterministically without mutating input", () => {
    const issueStatuses = ["open", "in_progress", "resolved", "closed", "archived"];
    const taskStatuses = ["todo", "doing", "blocked", "review", "done", "cancelled"];
    for (const [kind, statuses, expected] of [
      ["issue", issueStatuses, ["backlog", "in_progress", "review", "done", "done"]],
      ["task", taskStatuses, ["todo", "in_progress", "in_progress", "review", "done", "done"]],
    ] as const) {
      expect(
        statuses.map(
          (status) => parseGithiveCards(list([{ id, title: "Card", status }]), kind)[0]?.column,
        ),
      ).toEqual(expected);
    }
    const issue = parseGithiveCards(list([{ id, title: "Alpha", status: "open" }]), "issue")[0]!;
    const task = parseGithiveCards(list([{ id, title: "Beta", status: "todo" }]), "task")[0]!;
    const cards = [task, issue];
    expect(groupKanbanCards(cards)).toEqual(groupKanbanCards(cards.toReversed()));
    expect(groupKanbanCards(cards, "ALPHA").flatMap((column) => column.cards)).toEqual([issue]);
    expect(cards).toEqual([task, issue]);
    expect(groupKanbanCards([]).map((column) => column.column)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "review",
      "done",
    ]);
  });

  it("fails on malformed envelopes, records, duplicate IDs and unknown statuses", () => {
    for (const json of [
      "garbage",
      "{}",
      '{"ok":false}',
      list([{ id, title: "A", status: "unknown" }]),
      list([{ id, title: "A", status: "constructor" }]),
      list([{ id, title: "A", status: "__proto__" }]),
      list([{ id: "--help", title: "A", status: "open" }]),
      list([{ id, title: " ", status: "open" }]),
      list([
        { id, title: "A", status: "open" },
        { id, title: "B", status: "open" },
      ]),
      '{"ok":true,"data":{"items":[],"total":1}}',
    ]) {
      expect(() => parseGithiveCards(json, "issue")).toThrow();
    }
    expect(isGithiveMoveApplied('{"ok":true,"data":{"applied":true}}')).toBe(true);
    for (const json of [
      "{}",
      '{"ok":false,"data":{"applied":true}}',
      '{"ok":true,"data":{"applied":false}}',
    ])
      expect(isGithiveMoveApplied(json)).toBe(false);
  });

  it("honors the native state machines including reopen and archived terminal states", () => {
    const cases = [
      ["issue", "open", "in_progress", "in_progress"],
      ["issue", "open", "todo", null],
      ["issue", "in_progress", "review", "resolved"],
      ["issue", "closed", "backlog", "open"],
      ["issue", "archived", "backlog", null],
      ["issue", "open", "done", "closed"],
      ["task", "todo", "in_progress", "doing"],
      ["task", "blocked", "in_progress", "doing"],
      ["task", "todo", "done", null],
      ["task", "blocked", "review", null],
      ["task", "doing", "review", "review"],
      ["task", "review", "done", "done"],
      ["task", "done", "todo", "todo"],
      ["task", "cancelled", "todo", "todo"],
      ["task", "done", "backlog", null],
      ["task", "doing", "in_progress", "doing"],
    ] as const;
    for (const [kind, status, target, expected] of cases) {
      const card = parseGithiveCards(list([{ id, title: "Card", status }]), kind)[0]!;
      expect(kanbanTransitionStatus(card, target), `${kind}:${status}->${target}`).toBe(expected);
    }
  });
});

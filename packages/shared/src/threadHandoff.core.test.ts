import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadHandoffContext,
  type ThreadHandoffBuildInput,
  type ThreadHandoffEntry,
} from "./threadHandoff.core.ts";

const source: ThreadHandoffBuildInput["source"] = {
  threadId: "thread-1",
  title: "Fix login",
  model: "codex / gpt-5.4",
  branch: "fix/login",
  workspaceRoot: "/repo/worktrees/login",
  changedFiles: ["src/login.ts"],
};

const build = (
  entries: ReadonlyArray<ThreadHandoffEntry>,
  overrides: Partial<ThreadHandoffBuildInput> = {},
) => buildThreadHandoffContext({ source, entries, mode: "raw", maxBytes: 1_000_000, ...overrides });

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("buildThreadHandoffContext", () => {
  it("keeps user and assistant messages verbatim under a metadata header", () => {
    const user = "ログインが壊れた 🔥\n\n## not a heading of ours";
    const assistant = "```ts\nconst fixed = true;\n```";
    const result = build([
      { kind: "user", text: user },
      { kind: "assistant", text: assistant },
      { kind: "error", message: "Provider timed out" },
      { kind: "tool", label: "vp test run", output: "1 failed", exitCode: 1 },
    ]);

    expect(result.text).toContain(`**User:**\n${user}`);
    expect(result.text).toContain(`**Assistant:**\n${assistant}`);
    expect(result.text).toContain("- Source thread: Fix login (thread-1)");
    expect(result.text).toContain("- Source model: codex / gpt-5.4");
    expect(result.text).toContain("- Branch: fix/login");
    expect(result.text).toContain("- Workspace root: /repo/worktrees/login");
    expect(result.text).toContain("- Changed files: src/login.ts");
    expect(result.text).toContain("  - Provider timed out\n  - `vp test run` exited with 1");
    expect(result.text).toContain("1 failed");
    expect(result).toMatchObject({ turnCount: 1, omittedTurnCount: 0, overBudget: false });
    expect(result.bytes).toBe(bytes(result.text));
  });

  it("truncates oversized tool output by lines and bytes with markers", () => {
    const manyLines = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const wideLine = "あ".repeat(10_000);
    const result = build([
      { kind: "user", text: "run it" },
      { kind: "tool", label: "seq 200", output: manyLines, exitCode: 0 },
      { kind: "tool", label: "wide", output: wideLine },
      { kind: "tool", label: `cat <<EOF\n${"z".repeat(5_000)}\nEOF` },
    ]);

    expect(result.text).toContain("line 39\n[... truncated 120 lines, ");
    expect(result.text).toContain("...]\nline 160");
    expect(result.text).not.toContain("line 100\n");
    expect(result.text).toMatch(/\[\.\.\. truncated 0 lines, \d+ bytes \.\.\.\]/);
    expect(result.text).toContain("[... truncated 3014 bytes ...]");
    expect(result.text).not.toContain("�");
    expect(result.truncatedToolOutputCount).toBe(2);
  });

  it("compact mode drops tool output but keeps messages and the command", () => {
    const result = build(
      [
        { kind: "user", text: "check" },
        { kind: "tool", label: "git status", output: "secret noisy output", exitCode: 0 },
        { kind: "assistant", text: "Clean." },
      ],
      { mode: "compact" },
    );

    expect(result.text).toContain("git status");
    expect(result.text).not.toContain("secret noisy output");
    expect(result.text).toContain("**Assistant:**\nClean.");
    expect(result.text).toContain("1 of 1 turns, compact mode");
  });

  it("fences tool output that itself contains code fences", () => {
    const result = build([
      { kind: "user", text: "cat" },
      { kind: "tool", label: "cat README.md", output: "```\ncode\n```" },
    ]);

    expect(result.text).toContain("````\n```\ncode\n```\n````");
  });

  it("drops only the oldest turns to fit the budget", () => {
    const entries: ReadonlyArray<ThreadHandoffEntry> = Array.from({ length: 10 }, (_, index) => [
      { kind: "user" as const, text: `request ${index} ${"x".repeat(200)}` },
      { kind: "assistant" as const, text: `answer ${index}` },
    ]).flat();
    const full = build(entries);
    const trimmed = build(entries, { maxBytes: Math.floor(full.bytes / 2) });

    expect(trimmed.bytes).toBeLessThanOrEqual(Math.floor(full.bytes / 2));
    expect(trimmed.omittedTurnCount).toBeGreaterThan(0);
    expect(trimmed.text).not.toContain("request 0 ");
    expect(trimmed.text).toContain("request 9 ");
    expect(trimmed.text).toContain(
      `the ${trimmed.omittedTurnCount} oldest turns were omitted to fit ${Math.floor(full.bytes / 2)} bytes`,
    );
    expect(trimmed.overBudget).toBe(false);
  });

  it("keeps the newest turn whole and reports it when it alone exceeds the budget", () => {
    const result = build(
      [
        { kind: "user", text: "old" },
        { kind: "user", text: `new ${"y".repeat(5_000)}` },
      ],
      { maxBytes: 100 },
    );

    expect(result).toMatchObject({ turnCount: 2, omittedTurnCount: 1, overBudget: true });
    expect(result.text).toContain(`new ${"y".repeat(5_000)}`);
  });

  it("keeps entries before the first user message as their own turn", () => {
    const result = build([
      { kind: "assistant", text: "Imported preamble" },
      { kind: "user", text: "go" },
    ]);

    expect(result.turnCount).toBe(2);
    expect(result.text.indexOf("Imported preamble")).toBeLessThan(result.text.indexOf("go"));
  });
});

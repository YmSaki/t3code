import { describe, expect, it } from "vite-plus/test";
import {
  classifyExistingRecordRole,
  extractExistingRecordProjectPath,
  parseExistingSourceTranscript,
  summarizeExistingSourceMetadata,
} from "./existingSourcesImport.core.ts";

describe("existingSourcesImport.core", () => {
  const fallbackTimestamp = "2026-01-01T00:00:00.000Z";

  it("parses Claude Code transcripts while filtering hidden and synthetic records", () => {
    const result = parseExistingSourceTranscript({
      source: "claudeAgent",
      fallbackSessionId: "claude-fallback",
      fallbackTimestamp,
      jsonl: [
        JSON.stringify({
          type: "user",
          sessionId: "11111111-1111-4111-8111-111111111111",
          cwd: "/Users/star/repo",
          timestamp: "2025-02-01T10:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Fix authentication race condition" }],
          },
        }),
        JSON.stringify({
          type: "user",
          isSidechain: true,
          timestamp: "2025-02-01T10:00:05.000Z",
          message: { role: "user", content: "Hidden sidechain" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2025-02-01T10:00:10.000Z",
          aiTitle: "Auth race condition fix",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "I added a mutex around token refresh." }],
          },
        }),
      ].join("\n"),
    });

    expect(result.thread).toEqual({
      source: "claudeAgent",
      sessionId: "11111111-1111-4111-8111-111111111111",
      workspacePath: "/Users/star/repo",
      title: "Auth race condition fix",
      model: "claude-sonnet-4-20250514",
      createdAt: "2025-02-01T10:00:00.000Z",
      updatedAt: "2025-02-01T10:00:10.000Z",
      messages: [
        {
          role: "user",
          text: "Fix authentication race condition",
          createdAt: "2025-02-01T10:00:00.000Z",
        },
        {
          role: "assistant",
          text: "I added a mutex around token refresh.",
          createdAt: "2025-02-01T10:00:10.000Z",
        },
      ],
    });
    expect(result.diagnostics.map((d) => d.reason)).toEqual(["hidden_record"]);
  });

  it("parses Codex transcripts, deduplicates dual user events and rejects subagent rollouts", () => {
    const mainRollout = parseExistingSourceTranscript({
      source: "codex",
      fallbackTimestamp,
      jsonl: [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-ses-1", cwd: "C:\\Users\\star\\repo" },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5-codex" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2025-02-01T11:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "## My request for Codex:\nOptimize SQL query" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2025-02-01T11:00:00.000Z",
          payload: {
            type: "user_message",
            message: "## My request for Codex:\nOptimize SQL query",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2025-02-01T11:00:10.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Added composite index." }],
          },
        }),
      ],
    });

    expect(mainRollout.thread?.sessionId).toBe("codex-ses-1");
    expect(mainRollout.thread?.workspacePath).toBe("C:\\Users\\star\\repo");
    expect(mainRollout.thread?.model).toBe("gpt-5-codex");
    expect(mainRollout.thread?.title).toBe("Optimize SQL query");
    expect(mainRollout.thread?.messages).toHaveLength(2);

    const subagentRollout = parseExistingSourceTranscript({
      source: "codex",
      fallbackTimestamp,
      jsonl: [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-sub", cwd: "/repo", source: { subagent: "review" } },
        }),
      ],
    });
    expect(subagentRollout.thread).toBeNull();
    expect(subagentRollout.diagnostics[0]?.reason).toBe("excluded_subagent");
  });

  it("parses Pi active branch tree and aggregates multi-source metadata by normalized path", () => {
    const piResult = parseExistingSourceTranscript({
      source: "pi",
      fallbackTimestamp,
      jsonl: [
        JSON.stringify({ type: "session", id: "pi-ses-1", cwd: "c:/users/star/repo/" }),
        JSON.stringify({
          type: "message",
          id: "n1",
          parentId: null,
          timestamp: "2025-02-01T12:00:00.000Z",
          message: { role: "user", content: "First prompt" },
        }),
        JSON.stringify({
          type: "message",
          id: "n2-abandoned",
          parentId: "n1",
          timestamp: "2025-02-01T12:00:05.000Z",
          message: { role: "assistant", content: "Abandoned reply" },
        }),
        JSON.stringify({
          type: "message",
          id: "n2-active",
          parentId: "n1",
          timestamp: "2025-02-01T12:00:10.000Z",
          message: { role: "assistant", model: "pi-sonnet", content: "Active branch reply" },
        }),
      ],
    });

    expect(piResult.thread?.messages.map((m) => m.text)).toEqual([
      "First prompt",
      "Active branch reply",
    ]);

    const codexResult = parseExistingSourceTranscript({
      source: "codex",
      fallbackTimestamp,
      jsonl: [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-ses-2", cwd: "C:\\Users\\Star\\Repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2025-02-01T13:00:00.000Z",
          payload: { type: "user_message", message: "Second source in same repo" },
        }),
      ],
    });

    const summaries = summarizeExistingSourceMetadata(
      [piResult.thread, codexResult.thread].filter((t) => t !== null),
    );
    expect(summaries).toEqual([
      {
        workspacePath: "c:/users/star/repo/",
        normalizedPath: "c:/users/star/repo",
        sources: ["pi", "codex"],
        threadCount: 2,
        messageCount: 3,
        lastActiveAt: "2025-02-01T13:00:00.000Z",
      },
    ]);

    expect(classifyExistingRecordRole("pi", { type: "session" })).toBe("system");
    expect(extractExistingRecordProjectPath("claudeAgent", { cwd: "/workspace/app" }).cwd).toBe(
      "/workspace/app",
    );
  });
});

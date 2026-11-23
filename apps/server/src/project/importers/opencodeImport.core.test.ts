import { describe, expect, it } from "vite-plus/test";
import { parseOpencodeSession, parseOpencodeSessions } from "./opencodeImport.core.ts";

describe("parseOpencodeSession", () => {
  const fallbackTimestamp = "2026-01-01T00:00:00.000Z";

  it("restores directory, sessionId, title, model and message parts from separate JSON records", () => {
    const result = parseOpencodeSession({
      fallbackTimestamp,
      session: JSON.stringify({
        id: "ses_abc123",
        directory: "/home/star/workspace/t3code",
        title: "Add local session import",
        time: { created: 1735776000000, updated: 1735776090000 },
      }),
      messages: [
        JSON.stringify({
          id: "msg_2",
          sessionID: "ses_abc123",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-4",
          time: { created: 1735776030000, completed: 1735776060000 },
        }),
        JSON.stringify({
          id: "msg_1",
          sessionID: "ses_abc123",
          role: "user",
          time: { created: 1735776010000 },
        }),
      ],
      parts: [
        JSON.stringify({
          id: "prt_2b",
          messageID: "msg_2",
          type: "text",
          text: "And added unit tests.",
          time: { start: 1735776045000 },
        }),
        JSON.stringify({
          id: "prt_1",
          messageID: "msg_1",
          type: "text",
          text: "Please implement OpenCode session import",
          time: { start: 1735776010000 },
        }),
        JSON.stringify({
          id: "prt_tool",
          messageID: "msg_2",
          type: "tool",
          text: "ignored tool payload",
        }),
        JSON.stringify({
          id: "prt_2a",
          messageID: "msg_2",
          type: "text",
          text: "I implemented the parser.",
          time: { start: 1735776031000 },
        }),
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.thread).toEqual({
      sessionId: "ses_abc123",
      directory: "/home/star/workspace/t3code",
      title: "Add local session import",
      model: "anthropic/claude-sonnet-4",
      createdAt: "2025-01-02T00:00:00.000Z",
      updatedAt: "2025-01-02T00:01:30.000Z",
      messages: [
        {
          id: "msg_1",
          role: "user",
          text: "Please implement OpenCode session import",
          createdAt: "2025-01-02T00:00:10.000Z",
        },
        {
          id: "msg_2",
          role: "assistant",
          text: "I implemented the parser.\nAnd added unit tests.",
          createdAt: "2025-01-02T00:00:30.000Z",
        },
      ],
    });
  });

  it("derives title from the first user message when session title is a placeholder and falls back to message path/model", () => {
    const result = parseOpencodeSession({
      fallbackTimestamp,
      session: {
        info: {
          id: "ses_bundled",
          title: "New session - 2025-01-02",
        },
        messages: [
          {
            id: "m1",
            role: "user",
            path: { root: "C:\\Users\\star\\t3code" },
            parts: [{ type: "text", text: "Fix WSL path normalization\nMore details" }],
            time: { created: 1735776005000 },
          },
          {
            id: "m2",
            role: "assistant",
            model: { providerID: "openai", modelID: "gpt-5" },
            content: "Normalized WSL paths.",
            time: { created: 1735776015000 },
          },
        ],
      },
    });

    expect(result.thread?.title).toBe("Fix WSL path normalization");
    expect(result.thread?.directory).toBe("C:\\Users\\star\\t3code");
    expect(result.thread?.model).toBe("openai/gpt-5");
    expect(result.thread?.messages).toHaveLength(2);
  });

  it("records diagnostics for corrupt JSON, orphan parts, unsupported roles and empty messages without failing the session", () => {
    const result = parseOpencodeSession({
      fallbackTimestamp,
      session: { id: "ses_resilient", directory: "/repo" },
      messages: [
        "{broken-json",
        { id: "m-sys", role: "system", text: "system prompt" },
        { id: "m-empty", role: "assistant", parts: [{ type: "step-start" }] },
        { id: "m-ok", role: "user", text: "Still recoverable", time: { created: 1735776000000 } },
      ],
      parts: [
        "{broken-part",
        { id: "p-orphan", messageID: "m-nonexistent", type: "text", text: "orphan" },
        { id: "p-no-msg", type: "text", text: "missing messageID" },
      ],
    });

    expect(result.thread?.sessionId).toBe("ses_resilient");
    expect(result.thread?.messages).toEqual([
      {
        id: "m-ok",
        role: "user",
        text: "Still recoverable",
        createdAt: "2025-01-02T00:00:00.000Z",
      },
    ]);

    expect(result.diagnostics.map((d) => `${d.scope}:${d.reason}`)).toEqual([
      "part:invalid_json",
      "part:orphan_part",
      "message:invalid_json",
      "message:unsupported_role",
      "message:empty_message",
      "part:orphan_part",
    ]);
  });

  it("batches multiple sessions via parseOpencodeSessions", () => {
    const batch = parseOpencodeSessions([
      { session: "{invalid" },
      {
        session: { id: "ses_1", directory: "/a" },
        messages: [{ id: "m1", role: "user", text: "Hello", time: { created: 1735776000000 } }],
      },
    ]);
    expect(batch.threads).toHaveLength(1);
    expect(batch.threads[0]?.sessionId).toBe("ses_1");
    expect(batch.diagnostics).toHaveLength(1);
  });
});

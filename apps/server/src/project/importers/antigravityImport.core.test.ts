import { describe, expect, it } from "vite-plus/test";
import { parseAntigravitySession } from "./antigravityImport.core.ts";

describe("parseAntigravitySession", () => {
  const fallbackTimestamp = "2026-01-01T00:00:00.000Z";

  it("restores workspace, title, model and messages from Antigravity transcript JSONL and metadata", () => {
    const jsonl = [
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2025-01-02T00:00:20.000Z",
        content: "Here is the pure parser implementation.",
      }),
      JSON.stringify({
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2025-01-02T00:00:10.000Z",
        content:
          "<SYSTEM_MESSAGE>internal</SYSTEM_MESSAGE><USER_REQUEST>\nImplement Antigravity importer\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2025-01-02T00:00:15.000Z",
        content: "",
        tool_calls: [{ name: "read_file" }],
      }),
    ].join("\n");

    const result = parseAntigravitySession({
      fallbackTimestamp,
      metadata: JSON.stringify({
        conversationId: "ag-conv-1",
        title: "Antigravity Import Feature",
        workspacePath: "file:///c%3A/programing/t3code",
        model: "gemini-2.5-pro",
        createdAt: "2025-01-02T00:00:00.000Z",
        updatedAt: "2025-01-02T00:01:00.000Z",
      }),
      jsonl,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.thread).toEqual({
      sessionId: "ag-conv-1",
      workspacePath: "C:\\programing\\t3code",
      title: "Antigravity Import Feature",
      model: "gemini-2.5-pro",
      createdAt: "2025-01-02T00:00:00.000Z",
      updatedAt: "2025-01-02T00:01:00.000Z",
      messages: [
        {
          stepIndex: 1,
          role: "user",
          text: "Implement Antigravity importer",
          createdAt: "2025-01-02T00:00:10.000Z",
        },
        {
          stepIndex: 2,
          role: "assistant",
          text: "Here is the pure parser implementation.",
          createdAt: "2025-01-02T00:00:20.000Z",
        },
      ],
    });
  });

  it("extracts inline metadata and derives title from the first user request when metadata is omitted", () => {
    const result = parseAntigravitySession({
      fallbackSessionId: "ag-fallback",
      fallbackTimestamp,
      jsonl: [
        {
          type: "session_metadata",
          active_workspaces: ["/home/star/t3code"],
          model_name: "gemini-2.5-flash",
        },
        {
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2025-01-02T00:00:05.000Z",
          content: "Build projectRulesImport.core.ts\nWith YAML frontmatter parsing",
        },
      ],
    });

    expect(result.thread?.sessionId).toBe("ag-fallback");
    expect(result.thread?.workspacePath).toBe("/home/star/t3code");
    expect(result.thread?.model).toBe("gemini-2.5-flash");
    expect(result.thread?.title).toBe("Build projectRulesImport.core.ts");
  });

  it("tolerates corrupt JSONL lines, invalid metadata and empty turns while recording diagnostics", () => {
    const result = parseAntigravitySession({
      fallbackTimestamp,
      metadata: "{bad-meta",
      jsonl: [
        "{corrupt-line",
        "123",
        JSON.stringify({
          step_index: 1,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          content: "<SYSTEM_MESSAGE>only system</SYSTEM_MESSAGE>",
        }),
        JSON.stringify({
          step_index: 2,
          source: "UNKNOWN",
          type: "MYSTERY_STEP",
          content: "mystery",
        }),
        JSON.stringify({
          step_index: 3,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          created_at: "2025-01-02T00:00:10.000Z",
          content: "Valid request after corrupt lines",
        }),
      ].join("\n"),
    });

    expect(result.thread?.messages).toHaveLength(1);
    expect(result.thread?.messages[0]?.text).toBe("Valid request after corrupt lines");
    expect(result.diagnostics.map((d) => `${String(d.line)}:${d.reason}`)).toEqual([
      "null:invalid_metadata_json",
      "1:invalid_jsonl_line",
      "2:non_object_record",
      "3:empty_message",
      "4:ignored_step",
    ]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { parseCursorStateDb, parseCursorWorkspaceJson } from "./cursorImport.core.ts";

describe("parseCursorWorkspaceJson", () => {
  it("resolves Windows file:// folder URIs", () => {
    const result = parseCursorWorkspaceJson(
      JSON.stringify({ folder: "file:///c%3A/Users/star/projects/t3code" }),
    );
    expect(result).toEqual({
      workspacePath: "C:\\Users\\star\\projects\\t3code",
      rawFolderUri: "file:///c%3A/Users/star/projects/t3code",
      remoteDistro: null,
      diagnostics: [],
    });
  });

  it("resolves POSIX file:// and vscode-remote WSL folder URIs", () => {
    const posix = parseCursorWorkspaceJson({ folder: "file:///home/star/t3code" });
    expect(posix.workspacePath).toBe("/home/star/t3code");
    expect(posix.remoteDistro).toBeNull();

    const wsl = parseCursorWorkspaceJson({
      folder: "vscode-remote://wsl%2BUbuntu-24.04/home/star/t3code",
    });
    expect(wsl.workspacePath).toBe("/home/star/t3code");
    expect(wsl.remoteDistro).toBe("Ubuntu-24.04");
  });

  it("records diagnostics for malformed JSON or missing folder", () => {
    const malformed = parseCursorWorkspaceJson("{not-json");
    expect(malformed.workspacePath).toBeNull();
    expect(malformed.diagnostics).toEqual([
      expect.objectContaining({ key: "workspace.json", reason: "invalid_json" }),
    ]);

    const empty = parseCursorWorkspaceJson(JSON.stringify({}));
    expect(empty.workspacePath).toBeNull();
    expect(empty.diagnostics).toEqual([
      expect.objectContaining({ key: "workspace.json", reason: "invalid_workspace" }),
    ]);
  });
});

describe("parseCursorStateDb", () => {
  const fallbackTimestamp = "2026-01-01T00:00:00.000Z";

  it("parses inline composer.composerData and legacy aichat.chatdata across generations", () => {
    const result = parseCursorStateDb({
      workspaceJson: JSON.stringify({ folder: "file:///Users/star/repo" }),
      fallbackTimestamp,
      entries: [
        {
          key: "composer.composerData",
          value: JSON.stringify({
            allComposers: [
              {
                composerId: "comp-1",
                name: "Refactor auth",
                createdAt: 1735776000000,
                lastUpdatedAt: 1735776060000,
                modelConfig: { modelName: "claude-3-7-sonnet" },
                conversation: [
                  {
                    bubbleId: "b-2",
                    type: 2,
                    text: "I updated the auth handler.",
                    createdAt: 1735776030000,
                  },
                  {
                    bubbleId: "b-1",
                    type: 1,
                    text: "Please refactor the auth handler",
                    createdAt: 1735776010000,
                  },
                ],
              },
            ],
          }),
        },
        {
          key: "workbench.panel.aichat.view.aichat.chatdata",
          value: JSON.stringify({
            tabs: [
              {
                tabId: "tab-1",
                chatTitle: "Explain query",
                lastSendTime: 1735780050000,
                modelName: "gpt-4o",
                bubbles: [
                  { type: "user", text: "How does this SQL index work?", timestamp: 1735780000000 },
                  { type: "ai", rawText: "It covers the composite key.", timestamp: 1735780020000 },
                ],
              },
            ],
          }),
        },
      ],
    });

    expect(result.workspacePath).toBe("/Users/star/repo");
    expect(result.diagnostics).toEqual([]);
    expect(result.threads).toHaveLength(2);

    expect(result.threads[0]).toEqual({
      sessionId: "comp-1",
      sourceKey: "composer.composerData",
      title: "Refactor auth",
      model: "claude-3-7-sonnet",
      workspacePath: "/Users/star/repo",
      createdAt: "2025-01-02T00:00:00.000Z",
      updatedAt: "2025-01-02T00:01:00.000Z",
      messages: [
        {
          id: "b-1",
          role: "user",
          text: "Please refactor the auth handler",
          createdAt: "2025-01-02T00:00:10.000Z",
        },
        {
          id: "b-2",
          role: "assistant",
          text: "I updated the auth handler.",
          createdAt: "2025-01-02T00:00:30.000Z",
        },
      ],
    });

    expect(result.threads[1]).toEqual({
      sessionId: "tab-1",
      sourceKey: "workbench.panel.aichat.view.aichat.chatdata",
      title: "Explain query",
      model: "gpt-4o",
      workspacePath: "/Users/star/repo",
      createdAt: "2025-01-02T01:06:40.000Z",
      updatedAt: "2025-01-02T01:07:30.000Z",
      messages: [
        {
          id: null,
          role: "user",
          text: "How does this SQL index work?",
          createdAt: "2025-01-02T01:06:40.000Z",
        },
        {
          id: null,
          role: "assistant",
          text: "It covers the composite key.",
          createdAt: "2025-01-02T01:07:00.000Z",
        },
      ],
    });
  });

  it("reassembles split cursorDiskKV composerData and bubbleId entries", () => {
    const result = parseCursorStateDb({
      fallbackTimestamp,
      entries: [
        {
          key: "composer.composerData",
          value: JSON.stringify({
            allComposers: [
              { composerId: "comp-kv", name: "Split KV Session", createdAt: 1735776000000 },
            ],
          }),
        },
        {
          key: "composerData:comp-kv",
          value: JSON.stringify({
            composerId: "comp-kv",
            model: "claude-sonnet-4",
            fullConversationHeadersOnly: [
              { bubbleId: "b-user", type: 1 },
              { bubbleId: "b-missing", type: 2 },
              { bubbleId: "b-ai", type: 2 },
            ],
          }),
        },
        {
          key: "bubbleId:comp-kv:b-user",
          value: JSON.stringify({
            bubbleId: "b-user",
            type: 1,
            text: "First split message",
            createdAt: 1735776001000,
          }),
        },
        {
          key: "bubbleId:comp-kv:b-ai",
          value: JSON.stringify({
            bubbleId: "b-ai",
            type: 2,
            text: "Second split response",
            createdAt: 1735776002000,
          }),
        },
      ],
    });

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.title).toBe("Split KV Session");
    expect(result.threads[0]?.model).toBe("claude-sonnet-4");
    expect(result.threads[0]?.messages.map((m) => m.text)).toEqual([
      "First split message",
      "Second split response",
    ]);
    expect(result.diagnostics).toEqual([
      {
        key: "composerData:comp-kv",
        reason: "missing_bubble",
        detail: "Missing bubble b-missing for composer comp-kv",
      },
    ]);
  });

  it("records diagnostics for unknown keys, corrupt JSON, invalid messages and empty threads without throwing", () => {
    const result = parseCursorStateDb({
      fallbackTimestamp,
      entries: [
        { key: "some.unknown.cursorKey", value: "{}" },
        { key: "composerData:broken", value: "{corrupt" },
        {
          key: "aichat.chatdata",
          value: JSON.stringify({
            tabs: [
              "not-an-object",
              {
                tabId: "empty-tab",
                bubbles: [
                  { type: "user", text: "   " },
                  { type: "system", text: "hidden" },
                ],
              },
              {
                tabId: "valid-tab",
                bubbles: [{ type: 1, text: "Derive title from me" }],
              },
            ],
          }),
        },
      ],
    });

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.sessionId).toBe("valid-tab");
    expect(result.threads[0]?.title).toBe("Derive title from me");

    const reasons = result.diagnostics.map((d) => `${d.key}:${d.reason}`);
    expect(reasons).toEqual([
      "some.unknown.cursorKey:unknown_key",
      "composerData:broken:invalid_json",
      "aichat.chatdata:invalid_thread",
      "aichat.chatdata:empty_message",
      "aichat.chatdata:invalid_message",
      "aichat.chatdata:empty_thread",
    ]);
  });
});

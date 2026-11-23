import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ExtendedAgentSessionScanner from "./ExtendedAgentSessionScanner.ts";

function createCursorSqliteFixture(dbPath: string) {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");

    const insertItem = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    insertItem.run(
      "composer.composerData",
      JSON.stringify({
        allComposers: [
          {
            composerId: "cur-comp-1",
            name: "Cursor SQLite Session",
            createdAt: 1735776000000,
          },
        ],
      }),
    );

    const insertKv = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insertKv.run(
      "composerData:cur-comp-1",
      JSON.stringify({
        composerId: "cur-comp-1",
        model: "claude-3-7-sonnet",
        fullConversationHeadersOnly: [
          { bubbleId: "b1", type: 1 },
          { bubbleId: "b2", type: 2 },
        ],
      }),
    );
    insertKv.run(
      "bubbleId:cur-comp-1:b1",
      JSON.stringify({
        bubbleId: "b1",
        type: 1,
        text: "Inspect state.vscdb in read-only mode",
        createdAt: 1735776001000,
      }),
    );
    insertKv.run(
      "bubbleId:cur-comp-1:b2",
      JSON.stringify({
        bubbleId: "b2",
        type: 2,
        text: "Loaded composer conversation from cursorDiskKV.",
        createdAt: 1735776005000,
      }),
    );
  } finally {
    db.close();
  }
}

describe("ExtendedAgentSessionScanner", () => {
  it.effect(
    "scans Cursor SQLite state.vscdb, OpenCode split storage, Antigravity transcripts and project rules",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scanner = yield* ExtendedAgentSessionScanner.ExtendedAgentSessionScanner;

        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ext-scanner-" });
        const workspaceRoot = path.join(tempRoot, "my-workspace");
        yield* fs.makeDirectory(path.join(workspaceRoot, ".cursor", "rules"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workspaceRoot, "AGENTS.md"),
          "# Workspace Guidelines\n\nKeep functional cores pure.",
        );
        yield* fs.writeFileString(
          path.join(workspaceRoot, ".cursor", "rules", "effect.mdc"),
          [
            "---",
            "description: Effect service rules",
            "globs: apps/server/**/*.ts",
            "alwaysApply: true",
            "---",
            "Use Context.Service instead of Context.Tag.",
          ].join("\n"),
        );

        const cursorDir = path.join(tempRoot, "cursor-storage", "ws-hash-1");
        yield* fs.makeDirectory(cursorDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(cursorDir, "workspace.json"),
          JSON.stringify({ folder: workspaceRoot }),
        );
        createCursorSqliteFixture(path.join(cursorDir, "state.vscdb"));

        const opencodeDir = path.join(tempRoot, "opencode-storage");
        yield* fs.makeDirectory(path.join(opencodeDir, "session", "proj1"), { recursive: true });
        yield* fs.makeDirectory(path.join(opencodeDir, "message", "oc-ses-1"), { recursive: true });
        yield* fs.makeDirectory(path.join(opencodeDir, "part", "oc-msg-1"), { recursive: true });

        yield* fs.writeFileString(
          path.join(opencodeDir, "session", "proj1", "oc-ses-1.json"),
          JSON.stringify({
            id: "oc-ses-1",
            directory: workspaceRoot,
            title: "OpenCode Split Session",
            model: "anthropic/claude-sonnet-4",
            time: { created: 1735777000000, updated: 1735777010000 },
          }),
        );
        yield* fs.writeFileString(
          path.join(opencodeDir, "message", "oc-ses-1", "oc-msg-1.json"),
          JSON.stringify({
            id: "oc-msg-1",
            sessionID: "oc-ses-1",
            role: "user",
            time: { created: 1735777001000 },
          }),
        );
        yield* fs.writeFileString(
          path.join(opencodeDir, "part", "oc-msg-1", "prt-1.json"),
          JSON.stringify({
            id: "prt-1",
            messageID: "oc-msg-1",
            type: "text",
            text: "Hello from OpenCode split storage",
          }),
        );

        const agDir = path.join(tempRoot, "antigravity", "ag-conv-1");
        yield* fs.makeDirectory(agDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(agDir, "metadata.json"),
          JSON.stringify({
            conversationId: "ag-conv-1",
            workspacePath: workspaceRoot,
            title: "Antigravity Brain Session",
            model: "gemini-2.5-pro",
          }),
        );
        yield* fs.writeFileString(
          path.join(agDir, "transcript.jsonl"),
          [
            JSON.stringify({
              step_index: 1,
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              created_at: "2025-01-02T02:00:00.000Z",
              content: "<USER_REQUEST>Build ExtendedAgentSessionScanner</USER_REQUEST>",
            }),
            JSON.stringify({
              step_index: 2,
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              created_at: "2025-01-02T02:00:05.000Z",
              content: "Implemented ExtendedAgentSessionScanner.",
            }),
          ].join("\n"),
        );

        const scanOut = yield* scanner.scanSessions({
          roots: {
            cursorWorkspaceStorageDir: path.join(tempRoot, "cursor-storage"),
            opencodeStorageDir: opencodeDir,
            antigravityDir: path.join(tempRoot, "antigravity"),
          },
        });

        expect(scanOut.threads.map((t) => `${t.source}:${t.sessionId}`)).toEqual([
          "cursor:cur-comp-1",
          "opencode:oc-ses-1",
          "antigravity:ag-conv-1",
        ]);

        const rulesOut = yield* scanner.scanProjectRules(workspaceRoot);
        expect(rulesOut.result.rules).toHaveLength(2);
        expect(rulesOut.result.instructionsMd).toContain("## AGENTS.md");
        expect(rulesOut.result.instructionsMd).toContain(
          "## .cursor/rules/effect.mdc: Effect service rules",
        );
      }).pipe(
        Effect.provide(Layer.provideMerge(ExtendedAgentSessionScanner.layer(), NodeServices.layer)),
      ),
  );
});

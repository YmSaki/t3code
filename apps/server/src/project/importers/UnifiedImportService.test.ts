import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ExtendedAgentSessionScanner from "./ExtendedAgentSessionScanner.ts";
import * as UnifiedImportService from "./UnifiedImportService.ts";

function writeCursorVscdb(dbPath: string) {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const stmt = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
    stmt.run(
      "composer.composerData",
      JSON.stringify({
        allComposers: [
          {
            composerId: "cursor-ses-1",
            name: "Cursor UI Polish",
            createdAt: 1735776200000,
            lastUpdatedAt: 1735776210000,
            modelConfig: { modelName: "claude-3-7-sonnet" },
            conversation: [
              {
                bubbleId: "cb-1",
                type: 1,
                text: "Polish the import modal layout",
                createdAt: 1735776201000,
              },
              {
                bubbleId: "cb-2",
                type: 2,
                text: "Aligned source badges and diagnostic counters.",
                createdAt: 1735776209000,
              },
              {
                bubbleId: "cb-empty",
                type: 2,
                text: "   ",
              },
            ],
          },
        ],
      }),
    );
  } finally {
    db.close();
  }
}

const testLayer = UnifiedImportService.layer.pipe(
  Layer.provideMerge(ExtendedAgentSessionScanner.layer()),
  Layer.provideMerge(NodeServices.layer),
);

describe("UnifiedImportService (6-source integration)", () => {
  it.effect(
    "scans all 6 local AI sources, imports selected sessions, synthesizes rules and handoff, and tracks diagnostics and duplicates",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* UnifiedImportService.UnifiedImportService;

        const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-unified-import-" });
        const workspaceRoot = path.join(tempRoot, "t3-project");
        yield* fs.makeDirectory(path.join(workspaceRoot, ".cursor", "rules"), { recursive: true });

        yield* fs.writeFileString(
          path.join(workspaceRoot, "AGENTS.md"),
          "# Architecture\n\nFunctional core, imperative shell.",
        );
        yield* fs.writeFileString(
          path.join(workspaceRoot, "CLAUDE.md"),
          "# Architecture\n\nFunctional core, imperative shell.",
        );
        yield* fs.writeFileString(
          path.join(workspaceRoot, ".cursor", "rules", "testing.mdc"),
          [
            "---",
            "description: Vitest Effect rules",
            "globs: ['**/*.test.ts']",
            "alwaysApply: false",
            "---",
            "Use it.effect and TestClock instead of wall-clock waits.",
          ].join("\n"),
        );

        const claudeDir = path.join(tempRoot, "claude");
        yield* fs.makeDirectory(claudeDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(claudeDir, "claude-ses-1.jsonl"),
          [
            "{corrupt-claude-line",
            JSON.stringify({
              type: "user",
              sessionId: "claude-ses-1",
              cwd: workspaceRoot,
              timestamp: "2025-01-02T00:00:01.000Z",
              message: { role: "user", content: "Design MetaProject schema" },
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2025-01-02T00:00:05.000Z",
              aiTitle: "MetaProject Schema Design",
              message: {
                role: "assistant",
                model: "claude-sonnet-4",
                content: "Defined MetaProject and member roles.",
              },
            }),
          ].join("\n"),
        );

        const codexDir = path.join(tempRoot, "codex");
        yield* fs.makeDirectory(codexDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(codexDir, "rollout-codex-1.jsonl"),
          [
            JSON.stringify({
              type: "session_meta",
              payload: { id: "codex-ses-1", cwd: `${workspaceRoot}/` },
            }),
            JSON.stringify({
              type: "turn_context",
              payload: { model: "gpt-5-codex" },
            }),
            JSON.stringify({
              type: "event_msg",
              timestamp: "2025-01-02T00:01:00.000Z",
              payload: { type: "user_message", message: "Implement Oxlint no-io rule" },
            }),
            JSON.stringify({
              type: "response_item",
              timestamp: "2025-01-02T00:01:10.000Z",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Enforced no-io-in-functional-core." }],
              },
            }),
          ].join("\n"),
        );

        const piDir = path.join(tempRoot, "pi");
        yield* fs.makeDirectory(piDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(piDir, "pi-ses-1.jsonl"),
          [
            JSON.stringify({ type: "session", id: "pi-ses-1", cwd: workspaceRoot }),
            JSON.stringify({ type: "session_info", name: "Pi Worklog Calendar" }),
            JSON.stringify({
              type: "message",
              id: "p1",
              parentId: null,
              timestamp: "2025-01-02T00:02:00.000Z",
              message: { role: "user", content: "Generate RFC 5545 iCal feed" },
            }),
            JSON.stringify({
              type: "message",
              id: "p2",
              parentId: "p1",
              timestamp: "2025-01-02T00:02:10.000Z",
              message: {
                role: "assistant",
                model: "pi-fast",
                content: "Added 75-octet UTF-8 line folding.",
              },
            }),
          ].join("\n"),
        );

        const cursorDir = path.join(tempRoot, "cursor", "ws-1");
        yield* fs.makeDirectory(cursorDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(cursorDir, "workspace.json"),
          JSON.stringify({ folder: workspaceRoot }),
        );
        writeCursorVscdb(path.join(cursorDir, "state.vscdb"));

        const opencodeDir = path.join(tempRoot, "opencode");
        yield* fs.makeDirectory(opencodeDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(opencodeDir, "opencode-ses-1.json"),
          JSON.stringify({
            info: {
              id: "opencode-ses-1",
              directory: workspaceRoot,
              title: "OpenCode RepoMonitor",
              model: "anthropic/claude-sonnet-4",
              time: { created: 1735776300000, updated: 1735776320000 },
            },
            messages: [
              {
                id: "oc-m1",
                role: "user",
                text: "Add cooldown guard to RepoMonitor",
                time: { created: 1735776301000 },
              },
              {
                id: "oc-m2",
                role: "assistant",
                text: "Implemented deterministic dedupeKey and hourly rate limit.",
                time: { created: 1735776315000 },
              },
            ],
          }),
        );

        const antigravityDir = path.join(tempRoot, "antigravity", "ag-ses-1");
        yield* fs.makeDirectory(antigravityDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(antigravityDir, "metadata.json"),
          JSON.stringify({
            conversationId: "ag-ses-1",
            workspacePath: workspaceRoot,
            title: "Antigravity Artifact Bridge",
            model: "gemini-2.5-pro",
          }),
        );
        yield* fs.writeFileString(
          path.join(antigravityDir, "transcript.jsonl"),
          [
            JSON.stringify({
              step_index: 1,
              source: "USER_EXPLICIT",
              type: "USER_INPUT",
              created_at: "2025-01-02T00:06:00.000Z",
              content: "<USER_REQUEST>Build sandboxed artifact bridge</USER_REQUEST>",
            }),
            JSON.stringify({
              step_index: 2,
              source: "MODEL",
              type: "PLANNER_RESPONSE",
              created_at: "2025-01-02T00:06:10.000Z",
              content: "Added userActivation check and 16 KiB state cap.",
            }),
          ].join("\n"),
        );

        const roots: ExtendedAgentSessionScanner.ExtendedScannerRoots = {
          claudeDir,
          codexDir,
          piDir,
          cursorWorkspaceStorageDir: path.join(tempRoot, "cursor"),
          opencodeStorageDir: opencodeDir,
          antigravityDir: path.join(tempRoot, "antigravity"),
        };

        const scanResult = yield* service.scanAll({ roots });
        expect(scanResult.candidates).toHaveLength(1);
        const candidate = scanResult.candidates[0];
        expect(candidate?.sources).toEqual([
          "claudeAgent",
          "codex",
          "pi",
          "cursor",
          "opencode",
          "antigravity",
        ]);
        expect(candidate?.threadCount).toBe(6);
        expect(candidate?.messageCount).toBe(12);
        expect(candidate?.ruleFileCount).toBe(2);
        expect(candidate?.alreadyImported).toBe(false);
        expect(scanResult.diagnosticsSummary.skippedCount).toBeGreaterThanOrEqual(2);

        const importResult = yield* service.importSelected(
          {
            workspaceRoot,
            includeRules: true,
            generateHandoff: true,
          },
          { roots },
        );

        expect(importResult.importedCount).toBe(6);
        expect(importResult.duplicateCount).toBe(0);
        expect(importResult.threads).toHaveLength(6);
        expect(importResult.threads.map((t) => t.source)).toEqual([
          "claudeAgent",
          "codex",
          "pi",
          "cursor",
          "opencode",
          "antigravity",
        ]);
        for (const thread of importResult.threads) {
          expect(thread.messages).toHaveLength(2);
          expect(thread.handoffSummary).toContain(thread.sessionId);
        }

        expect(importResult.instructionsMd).toContain("## AGENTS.md");
        expect(importResult.instructionsMd).toContain("> Merged from: `AGENTS.md`, `CLAUDE.md`");
        expect(importResult.instructionsMd).toContain(
          "## .cursor/rules/testing.mdc: Vitest Effect rules",
        );

        expect(importResult.handoffMarkdown).toContain("# Context Handoff:");
        expect(importResult.handoffMarkdown).toContain("[claudeAgent] MetaProject Schema Design");
        expect(importResult.handoffMarkdown).toContain("[antigravity] Antigravity Artifact Bridge");

        const reasonMap = new Map(
          importResult.diagnosticsSummary.byReason.map((r) => [r.reason, r.count]),
        );
        expect(reasonMap.get("invalid_jsonl_line")).toBe(1);
        expect(reasonMap.get("empty_message")).toBe(1);
        expect(reasonMap.get("duplicate_rule")).toBe(1);

        const scanAfterImport = yield* service.scanAll({ roots });
        expect(scanAfterImport.candidates[0]?.alreadyImported).toBe(true);

        const secondImport = yield* service.importSelected({ workspaceRoot }, { roots });
        expect(secondImport.importedCount).toBe(0);
        expect(secondImport.duplicateCount).toBe(6);

        const selectiveReimport = yield* service.importSelected(
          {
            workspaceRoot,
            sources: ["cursor", "antigravity"],
            sessionIds: ["ag-ses-1"],
            forceReimport: true,
          },
          { roots },
        );
        expect(selectiveReimport.importedCount).toBe(1);
        expect(selectiveReimport.threads[0]?.sessionId).toBe("ag-ses-1");
      }).pipe(Effect.provide(testLayer)),
  );
});

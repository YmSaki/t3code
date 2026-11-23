import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AgentSessionProjectCandidateExtended,
  type AgentSessionSelectiveImportInput,
  type AuthSessionState,
  type UnifiedAgentSessionImportResult,
  type UnifiedAgentSessionScanResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  buildSelectiveImportInputs,
  clearImportWorkspaceSelection,
  countScanDiagnostics,
  createAgentSessionImportEnvironmentAtoms,
  createEmptyImportSelectionState,
  EXTENDED_IMPORT_SOURCES,
  filterImportProjectCandidates,
  isAllWorkspacesSelected,
  mergeUnifiedImportResults,
  selectAllImportWorkspaces,
  selectAllSessionIds,
  toggleSessionSelection,
  toggleWorkspaceSelection,
  toScanAllRpcInput,
} from "./agentSessionImport.ts";
import { awaitAtomResult, runAtomCommand } from "./runtime.ts";

const envId = EnvironmentId.make("env-import");

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessionsAtom }),
}));

const testAuthSessionState: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationOperateScope],
};

const sessionsAtom = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(
    AsyncResult.success(testAuthSessionState),
  ),
);

function makeCandidate(
  overrides: Partial<AgentSessionProjectCandidateExtended> = {},
): AgentSessionProjectCandidateExtended {
  return {
    path: "/workspace/t3code",
    normalizedPath: "/workspace/t3code",
    title: "t3code",
    projectId: ProjectId.make("proj-1"),
    sources: ["claudeAgent", "cursor"],
    threadCount: 3,
    messageCount: 12,
    ruleFileCount: 2,
    lastActiveAt: "2026-11-20T12:00:00.000Z",
    alreadyImported: false,
    ...overrides,
  };
}

function createTestImportAtoms() {
  return Effect.gen(function* () {
    let scanCalls = 0;
    let importedOnce = false;
    const importedPayloads: Array<AgentSessionSelectiveImportInput> = [];

    const client = {
      [WS_METHODS.agentSessionsScanAll]: (): Effect.Effect<UnifiedAgentSessionScanResult> =>
        Effect.sync(() => {
          scanCalls += 1;
          return {
            candidates: [
              makeCandidate({
                alreadyImported: importedOnce,
              }),
            ],
            scannedAt: "2026-11-22T10:00:00.000Z",
            diagnosticsSummary: {
              totalRecords: 14,
              importedCount: 12,
              skippedCount: 2,
              repairedTimestampCount: 1,
              byReason: [{ reason: "empty_message", count: 2 }],
              diagnostics: [
                {
                  source: "cursor",
                  scope: "bubble",
                  reason: "empty_message",
                  detail: "Bubble text was empty",
                  filePath: "/cursor/state.vscdb",
                  line: null,
                },
              ],
            },
          };
        }),
      [WS_METHODS.agentSessionsImportSelected]: (
        input: AgentSessionSelectiveImportInput,
      ): Effect.Effect<UnifiedAgentSessionImportResult> =>
        Effect.sync(() => {
          importedOnce = true;
          importedPayloads.push(input);
          return {
            workspaceRoot: input.workspaceRoot,
            importedCount: 2,
            skippedCount: 1,
            duplicateCount: 0,
            threads: [
              {
                source: "claudeAgent",
                sessionId: "ses-1",
                title: "Implement import UI",
                model: "claude-sonnet-4",
                workspacePath: input.workspaceRoot,
                createdAt: "2026-11-20T10:00:00.000Z",
                updatedAt: "2026-11-20T10:05:00.000Z",
                messageCount: 4,
                messages: [
                  {
                    role: "user",
                    text: "Build import wizard",
                    createdAt: "2026-11-20T10:00:00.000Z",
                  },
                ],
                handoffSummary: "Built import wizard.",
              },
            ],
            instructionsMd: "## AGENTS.md\n\nKeep cores pure.",
            handoffMarkdown: "# Context Handoff: t3code",
            diagnosticsSummary: {
              totalRecords: 5,
              importedCount: 4,
              skippedCount: 1,
              repairedTimestampCount: 0,
              byReason: [{ reason: "empty_message", count: 1 }],
              diagnostics: [],
            },
          };
        }),
    } as unknown as RpcSession["client"];

    const supervisor = EnvironmentSupervisor.of({
      target: { environmentId: envId, label: "Import Env" },
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
      state: yield* SubscriptionRef.make({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
      }),
      prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } as unknown as EnvironmentSupervisor["Service"]);

    const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor);

    const registryService = EnvironmentRegistry.of({
      run,
      followStream,
    } as unknown as EnvironmentRegistry["Service"]);

    const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, registryService));

    return {
      atoms: createAgentSessionImportEnvironmentAtoms(runtime),
      getScanCalls: () => scanCalls,
      importedPayloads,
    };
  });
}

describe("agentSessionImport pure helpers", () => {
  it("builds RPC scan inputs and filters candidates by source, time window, and project path", () => {
    expect(EXTENDED_IMPORT_SOURCES).toHaveLength(6);
    expect(toScanAllRpcInput()).toEqual({});
    expect(toScanAllRpcInput({ sources: ["cursor", "opencode"] })).toEqual({
      sources: ["cursor", "opencode"],
    });

    const recent = makeCandidate({
      path: "C:\\Repo\\Alpha",
      normalizedPath: "c:/repo/alpha",
      sources: ["cursor", "antigravity"],
      lastActiveAt: "2026-11-15T00:00:00.000Z",
    });
    const older = makeCandidate({
      path: "/workspace/beta",
      normalizedPath: "/workspace/beta",
      sources: ["opencode"],
      lastActiveAt: "2026-09-01T00:00:00.000Z",
    });

    const nowMs = Date.parse("2026-11-22T00:00:00.000Z");
    expect(
      filterImportProjectCandidates([recent, older], {
        timeWindow: "30d",
        nowMs,
      }),
    ).toEqual([recent]);

    expect(
      filterImportProjectCandidates([recent, older], {
        timeWindow: "90d",
        nowMs,
        sources: ["opencode"],
      }),
    ).toEqual([older]);

    expect(
      filterImportProjectCandidates([recent, older], {
        includeAllTime: true,
        nowMs,
        projectPath: "c:/repo/alpha/",
      }),
    ).toEqual([recent]);
  });

  it("manages workspace and session selection state and builds selective import payloads", () => {
    const c1 = makeCandidate({ path: "/repo/a", normalizedPath: "/repo/a" });
    const c2 = makeCandidate({
      path: "/repo/b",
      normalizedPath: "/repo/b",
      projectId: undefined,
    });

    let state = createEmptyImportSelectionState("meta-1");
    expect(isAllWorkspacesSelected(state, [c1, c2])).toBe(false);

    state = selectAllImportWorkspaces(state, [c1, c2]);
    expect(isAllWorkspacesSelected(state, [c1, c2])).toBe(true);

    state = toggleWorkspaceSelection(state, "/repo/a");
    expect(isAllWorkspacesSelected(state, [c1, c2])).toBe(false);
    expect(state.selectedWorkspaces).toEqual(["/repo/b"]);

    state = toggleSessionSelection(state, "ses-1");
    state = selectAllSessionIds(state, ["ses-1", "ses-2", "ses-1"]);
    expect(state.selectedSessionIds).toEqual(["ses-1", "ses-2"]);

    const inputs = buildSelectiveImportInputs(state, [c1, c2], {
      sources: ["cursor"],
    });
    expect(inputs).toEqual([
      {
        workspaceRoot: "/repo/b",
        sources: ["cursor"],
        sessionIds: ["ses-1", "ses-2"],
        includeRules: true,
        generateHandoff: true,
        forceReimport: false,
      },
    ]);

    state = clearImportWorkspaceSelection(state);
    expect(state.selectedWorkspaces).toEqual([]);
  });

  it("merges multiple import results and counts scan diagnostics", () => {
    const merged = mergeUnifiedImportResults([
      {
        workspaceRoot: "/repo/a",
        importedCount: 1,
        skippedCount: 2,
        duplicateCount: 1,
        threads: [],
        instructionsMd: "Rules A",
        handoffMarkdown: "Handoff A",
        diagnosticsSummary: {
          totalRecords: 3,
          importedCount: 1,
          skippedCount: 1,
          repairedTimestampCount: 1,
          byReason: [{ reason: "empty_message", count: 1 }],
          diagnostics: [
            {
              source: "codex",
              scope: "transcript",
              reason: "empty_message",
              detail: "empty",
            },
          ],
        },
      },
      {
        workspaceRoot: "/repo/b",
        importedCount: 2,
        skippedCount: 1,
        duplicateCount: 0,
        threads: [],
        instructionsMd: "Rules B",
        handoffMarkdown: null,
        diagnosticsSummary: {
          totalRecords: 3,
          importedCount: 2,
          skippedCount: 1,
          repairedTimestampCount: 0,
          byReason: [{ reason: "invalid_json", count: 1 }],
          diagnostics: [
            {
              source: "opencode",
              scope: "session",
              reason: "invalid_json",
              detail: "bad json",
            },
          ],
        },
      },
    ]);

    expect(merged?.importedCount).toBe(3);
    expect(merged?.duplicateCount).toBe(1);
    expect(merged?.instructionsMd).toBe("Rules A\n\n---\n\nRules B");
    expect(merged?.handoffMarkdown).toBe("Handoff A");
    expect(merged?.diagnosticsSummary.repairedTimestampCount).toBe(1);
    expect(merged?.diagnosticsSummary.byReason).toEqual([
      { reason: "empty_message", count: 1 },
      { reason: "invalid_json", count: 1 },
    ]);

    expect(countScanDiagnostics(null)).toBe(0);
  });
});

describe("createAgentSessionImportEnvironmentAtoms", () => {
  it.effect("scans unified sessions and refreshes scan query after importSelected", () =>
    Effect.gen(function* () {
      const { atoms, getScanCalls, importedPayloads } = yield* createTestImportAtoms();
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (r) => Effect.sync(() => r.dispose()),
      );
      registry.mount(sessionsAtom(envId));
      const scanAtom = atoms.scanAll({ environmentId: envId, input: {} });
      yield* AtomRegistry.mount(registry, scanAtom);

      const initialScan = yield* awaitAtomResult(registry, scanAtom);
      expect(initialScan.candidates[0]?.alreadyImported).toBe(false);
      expect(countScanDiagnostics(initialScan)).toBe(1);
      expect(getScanCalls()).toBe(1);

      const exit = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.importSelected, {
          environmentId: envId,
          input: {
            workspaceRoot: "/workspace/t3code",
            includeRules: true,
            generateHandoff: true,
          },
        }),
      );
      expect(exit._tag).toBe("Success");
      expect(importedPayloads).toHaveLength(1);

      const refreshedScan = yield* awaitAtomResult(registry, scanAtom);
      expect(refreshedScan.candidates[0]?.alreadyImported).toBe(true);
      expect(getScanCalls()).toBe(2);
    }).pipe(Effect.scoped),
  );
});

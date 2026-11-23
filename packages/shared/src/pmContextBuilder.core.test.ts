import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPmContext,
  PM_CONTEXT_TAG,
  type PmContextBoardSnapshot,
  type PmContextMetaProject,
} from "./pmContextBuilder.core.ts";

const envLocal = EnvironmentId.make("env-local");
const projWeb = ProjectId.make("proj-web");
const pmThreadId = ThreadId.make("thread-pm");
const workerThreadId = ThreadId.make("thread-worker-1");
const codexDriver = ProviderDriverKind.make("codex");
const acpDriver = ProviderDriverKind.make("acp");

const board: PmContextBoardSnapshot = {
  pmThreadId,
  metaProjectId: "meta-1",
  policy: {
    maxConcurrentWorkers: 4,
    requireWorktreeIsolation: true,
    allowNestedDelegation: false,
    allowedTargets: [{ environmentId: envLocal, projectId: projWeb }],
    maxDelegatedTurns: 12,
    directEditSuppressedProviders: [codexDriver],
  },
  killSwitchActive: false,
  delegatedTurnCount: 3,
  workers: [
    {
      threadId: workerThreadId,
      environmentId: envLocal,
      projectId: projWeb,
      title: "Migrate settings dialog",
      status: "running",
      targetRepoRole: "frontend",
      providerInstanceId: null,
      turnCount: 2,
      lastMessagePreview: "Updated the schema\nand running tests now.",
      startedAt: "2026-11-22T10:00:00.000Z",
      updatedAt: "2026-11-22T10:03:00.000Z",
    },
  ],
  generatedAt: "2026-11-22T10:04:00.000Z",
};

const metaProject: PmContextMetaProject = {
  id: "meta-1",
  name: "T3 Fleet",
  handbookMarkdown: "Always run check:changed before reporting completion.",
  members: [
    {
      environmentId: envLocal,
      projectId: projWeb,
      name: "t3-web",
      role: "frontend",
      environmentLabel: "Workstation",
    },
  ],
};

describe("buildPmContext", () => {
  it("produces a system payload for providers with system context support", () => {
    const result = buildPmContext({
      board,
      metaProject,
      providerDriver: codexDriver,
      supportsSystemContext: true,
      userPrompt: "Ship the new board view",
    });

    expect(result.mode).toBe("system");
    expect(result.directEditSuppressed).toBe(true);
    expect(result.inlinePrefix).toBeNull();
    expect(result.promptText).toBe("Ship the new board view");
    expect(result.systemContext).toContain("1/4 active workers");
    expect(result.systemContext).toContain("Direct workspace edits are suppressed");
    expect(result.systemContext).toContain("## MetaProject: T3 Fleet (meta-1)");
    expect(result.systemContext).toContain("[frontend] t3-web: env Workstation (env-local)");
    expect(result.systemContext).toContain("Always run check:changed");
    expect(result.systemContext).toContain(
      '[running] Migrate settings dialog (thread: thread-worker-1, role: frontend, target: env-local/proj-web, turns: 2): "Updated the schema and running tests now."',
    );
  });

  it("wraps context in <t3_pm_context> and prepends it when system context is unsupported", () => {
    const result = buildPmContext({
      board: { ...board, killSwitchActive: true },
      metaProject: null,
      providerDriver: acpDriver,
      supportsSystemContext: false,
      userPrompt: "Status check",
    });

    expect(result.mode).toBe("inline");
    expect(result.directEditSuppressed).toBe(false);
    expect(result.systemContext).toBeNull();
    expect(result.inlinePrefix).toMatch(
      new RegExp(`^<${PM_CONTEXT_TAG}>[\\s\\S]+</${PM_CONTEXT_TAG}>$`),
    );
    expect(result.inlinePrefix).not.toContain("<t3_code_instructions");
    expect(result.inlinePrefix).toContain("WARNING: The PM kill switch is active.");
    expect(result.promptText).toBe(`${result.inlinePrefix}\n\nStatus check`);
  });
});

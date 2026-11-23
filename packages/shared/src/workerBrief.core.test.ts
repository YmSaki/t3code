import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkerBriefPrompt,
  truncateUtf8,
  utf8ByteLength,
  type WorkerContextBrief,
  type WorkerFileExcerpt,
} from "./workerBrief.core.ts";

const brief: WorkerContextBrief = {
  objective: "Add the worker status badge to the PM board",
  background: "The PM board lists active workers across environments.",
  constraints: ["Do not touch server contracts", "Keep the badge accessible"],
  relatedFiles: [
    {
      path: "apps/web/src/pm/WorkerBadge.tsx",
      reason: "Render status pill",
      lineRange: { start: 10, end: 42 },
    },
  ],
  completionCriteria: ["Badge renders for all statuses", "Unit tests pass"],
  verificationCommands: ["vp test run apps/web/src/pm/WorkerBadge.test.tsx"],
};

const excerpts: ReadonlyArray<WorkerFileExcerpt> = [
  {
    path: "apps/web/src/pm/WorkerBadge.tsx",
    language: "tsx",
    lineRange: { start: 10, end: 42 },
    content: "export function WorkerBadge() {\n  return <span>running</span>;\n}\n".repeat(8),
  },
  {
    path: "apps/web/src/pm/Board.tsx",
    language: "tsx",
    content: "export function Board() {\n  return <div />;\n}\n".repeat(12),
  },
];

describe("truncateUtf8", () => {
  it("never splits multibyte characters when clamping to a byte budget", () => {
    const sample = "日本語のテキストを切り詰めるテスト";
    const result = truncateUtf8(sample, 32);
    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(32);
    expect(result.text).not.toContain("\uFFFD");
  });
});

describe("buildWorkerBriefPrompt", () => {
  it("includes every section when the budget fits the full pack", () => {
    const pack = buildWorkerBriefPrompt({
      title: "Status badge",
      brief,
      assignment: {
        pmThreadId: ThreadId.make("pm-1"),
        environmentId: EnvironmentId.make("env-1"),
        projectId: ProjectId.make("proj-1"),
        targetRepoRole: "frontend",
        runtimeMode: "full-access",
      },
      handbookMarkdown: "Follow repository lint rules.",
      excerpts,
    });

    expect(pack.truncated).toBe(false);
    expect(pack.includedSections).toEqual(["core", "background", "handbook", "excerpts"]);
    expect(pack.includedExcerptPaths).toEqual([
      "apps/web/src/pm/WorkerBadge.tsx",
      "apps/web/src/pm/Board.tsx",
    ]);
    expect(pack.omittedExcerptPaths).toEqual([]);
    expect(pack.prompt).toContain("# Worker Assignment: Status badge");
    expect(pack.prompt).toContain("`apps/web/src/pm/WorkerBadge.tsx:10-42`: Render status pill");
    expect(pack.prompt).toContain("## MetaProject Handbook");
    expect(pack.prompt).toContain("### `apps/web/src/pm/WorkerBadge.tsx:10-42`");
  });

  it("truncates excerpts first, then handbook, while keeping core and background intact", () => {
    const coreAndBackground = buildWorkerBriefPrompt({
      brief,
      handbookMarkdown: "H".repeat(600),
      excerpts,
      budget: { maxBytes: 750 },
    });

    expect(coreAndBackground.byteLength).toBeLessThanOrEqual(750);
    expect(coreAndBackground.truncated).toBe(true);
    expect(coreAndBackground.includedSections).toContain("core");
    expect(coreAndBackground.includedSections).toContain("background");
    expect(coreAndBackground.truncatedSections).toContain("excerpts");
    expect(coreAndBackground.omittedExcerptPaths).toEqual([
      "apps/web/src/pm/WorkerBadge.tsx",
      "apps/web/src/pm/Board.tsx",
    ]);
    expect(coreAndBackground.prompt).toContain("## Objective");
    expect(coreAndBackground.prompt).toContain("## Completion Criteria");
  });

  it("enforces token budgets converted to bytes", () => {
    const pack = buildWorkerBriefPrompt({
      brief,
      handbookMarkdown: "Handbook text ".repeat(50),
      excerpts,
      budget: { maxTokens: 150 },
    });

    expect(pack.effectiveMaxBytes).toBe(600);
    expect(pack.byteLength).toBeLessThanOrEqual(600);
    expect(pack.estimatedTokens).toBeLessThanOrEqual(150);
  });
});

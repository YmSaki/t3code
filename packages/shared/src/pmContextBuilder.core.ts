import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

export const PM_CONTEXT_TAG = "t3_pm_context";

export type PmWorkerStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface PmContextTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface PmContextPolicy {
  readonly maxConcurrentWorkers: number;
  readonly requireWorktreeIsolation: boolean;
  readonly allowNestedDelegation: boolean;
  readonly allowedTargets: ReadonlyArray<PmContextTarget>;
  readonly maxDelegatedTurns: number;
  readonly directEditSuppressedProviders: ReadonlyArray<ProviderDriverKind>;
}

export interface PmContextWorkerSummary {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status: PmWorkerStatus;
  readonly targetRepoRole: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly turnCount: number;
  readonly lastMessagePreview: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

export interface PmContextBoardSnapshot {
  readonly pmThreadId: ThreadId;
  readonly metaProjectId: string | null;
  readonly policy: PmContextPolicy;
  readonly killSwitchActive: boolean;
  readonly delegatedTurnCount: number;
  readonly workers: ReadonlyArray<PmContextWorkerSummary>;
  readonly generatedAt: string;
}

export interface PmContextRepoMember extends PmContextTarget {
  readonly name: string;
  readonly role: string;
  readonly environmentLabel?: string | undefined;
}

export interface PmContextMetaProject {
  readonly id: string;
  readonly name: string;
  readonly handbookMarkdown?: string | undefined;
  readonly members: ReadonlyArray<PmContextRepoMember>;
}

export interface PmContextBuildInput {
  readonly board: PmContextBoardSnapshot;
  readonly metaProject?: PmContextMetaProject | null | undefined;
  readonly providerDriver?: ProviderDriverKind | undefined;
  readonly supportsSystemContext: boolean;
  readonly userPrompt?: string | undefined;
}

export type PmContextDelivery =
  | {
      readonly mode: "system";
      readonly systemContext: string;
      readonly inlinePrefix: null;
      readonly promptText: string;
      readonly directEditSuppressed: boolean;
    }
  | {
      readonly mode: "inline";
      readonly systemContext: null;
      readonly inlinePrefix: string;
      readonly promptText: string;
      readonly directEditSuppressed: boolean;
    };

const ACTIVE_WORKER_STATUSES: ReadonlySet<PmWorkerStatus> = new Set([
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
]);

const singleLinePreview = (value: string, maxChars: number = 140): string => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
};

export function isActivePmWorkerStatus(status: PmWorkerStatus): boolean {
  return ACTIVE_WORKER_STATUSES.has(status);
}

function isDirectEditSuppressed(
  policy: Pick<PmContextPolicy, "directEditSuppressedProviders">,
  providerDriver: ProviderDriverKind | undefined,
): boolean {
  return (
    providerDriver !== undefined && policy.directEditSuppressedProviders.includes(providerDriver)
  );
}

function renderPmContextMarkdown(
  input: Omit<PmContextBuildInput, "supportsSystemContext" | "userPrompt">,
): string {
  const { board, metaProject, providerDriver } = input;
  const directEditSuppressed = isDirectEditSuppressed(board.policy, providerDriver);
  const activeCount = board.workers.filter((worker) =>
    isActivePmWorkerStatus(worker.status),
  ).length;
  const lines: Array<string> = [
    "# PM Role Guidelines",
    "- You are the Project Manager (PM) thread coordinating work across repositories and environments.",
    "- Break goals into scoped worker briefs with explicit completion criteria and verification commands.",
    `- Concurrency budget: ${activeCount}/${board.policy.maxConcurrentWorkers} active workers. Delegated turns used: ${board.delegatedTurnCount}/${board.policy.maxDelegatedTurns}.`,
    board.policy.requireWorktreeIsolation
      ? "- Worktree isolation is required for every dispatched worker."
      : "- Worktree isolation is optional for dispatched workers.",
  ];
  if (directEditSuppressed) {
    lines.push(
      "- Direct workspace edits are suppressed on this PM thread. Delegate file changes to a worker thread instead of editing files directly.",
    );
  }
  if (board.killSwitchActive) {
    lines.push(
      "- WARNING: The PM kill switch is active. Do not dispatch new workers until the user clears it.",
    );
  }

  if (metaProject !== undefined && metaProject !== null) {
    lines.push("", `## MetaProject: ${metaProject.name} (${metaProject.id})`);
    if (metaProject.members.length === 0) {
      lines.push("No repositories are linked to this MetaProject.");
    } else {
      lines.push("### Repositories");
      for (const member of metaProject.members) {
        const envLabel =
          member.environmentLabel === undefined
            ? member.environmentId
            : `${member.environmentLabel} (${member.environmentId})`;
        lines.push(
          `- [${member.role}] ${member.name}: env ${envLabel}, project ${member.projectId}`,
        );
      }
    }
    const handbook = metaProject.handbookMarkdown?.trim() ?? "";
    if (handbook !== "") {
      lines.push("", "### Handbook", handbook);
    }
  }

  lines.push("", `## Worker Board (as of ${board.generatedAt})`);
  if (board.workers.length === 0) {
    lines.push("No workers have been dispatched yet.");
  } else {
    for (const worker of board.workers) {
      const role = worker.targetRepoRole === null ? "unassigned" : worker.targetRepoRole;
      const preview =
        worker.lastMessagePreview === null || worker.lastMessagePreview.trim() === ""
          ? ""
          : `: "${singleLinePreview(worker.lastMessagePreview)}"`;
      lines.push(
        `- [${worker.status}] ${worker.title} (thread: ${worker.threadId}, role: ${role}, target: ${worker.environmentId}/${worker.projectId}, turns: ${worker.turnCount})${preview}`,
      );
    }
  }

  return lines.join("\n");
}

function wrapInlinePmContext(markdown: string): string {
  return `<${PM_CONTEXT_TAG}>\n${markdown}\n</${PM_CONTEXT_TAG}>`;
}

function prependInlinePmContext(inlinePrefix: string, userPrompt: string): string {
  return userPrompt === "" ? inlinePrefix : `${inlinePrefix}\n\n${userPrompt}`;
}

export function buildPmContext(input: PmContextBuildInput): PmContextDelivery {
  const markdown = renderPmContextMarkdown(input);
  const directEditSuppressed = isDirectEditSuppressed(input.board.policy, input.providerDriver);
  const userPrompt = input.userPrompt ?? "";
  if (input.supportsSystemContext) {
    return {
      mode: "system",
      systemContext: markdown,
      inlinePrefix: null,
      promptText: userPrompt,
      directEditSuppressed,
    };
  }
  const inlinePrefix = wrapInlinePmContext(markdown);
  return {
    mode: "inline",
    systemContext: null,
    inlinePrefix,
    promptText: prependInlinePmContext(inlinePrefix, userPrompt),
    directEditSuppressed,
  };
}

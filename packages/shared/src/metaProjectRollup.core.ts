import type { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";

export type RollupPullRequestState = "open" | "closed" | "merged";
export type RollupPullRequestChecksState = "passing" | "failing" | "pending";
export type RollupPullRequestReviewDecision = "approved" | "changes-requested" | "review-required";
export type RollupPullRequestMergeability = "mergeable" | "conflicting" | "unknown";

export interface RollupSourceRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface RollupPullRequestInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: RollupPullRequestState;
  readonly isDraft?: boolean | undefined;
  readonly checksState?: RollupPullRequestChecksState | null | undefined;
  readonly reviewDecision?: RollupPullRequestReviewDecision | null | undefined;
  readonly mergeability?: RollupPullRequestMergeability | undefined;
  readonly viewerReviewRequested?: boolean | undefined;
  readonly updatedAt: IsoDateTime;
}

export interface RollupPullRequestEntry extends RollupPullRequestInput {
  readonly canonicalKey: string;
  readonly sources: ReadonlyArray<RollupSourceRef>;
}

export type RollupIssueStateCategory = "open" | "closed";

export interface RollupIssueInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
  readonly displayKey: string;
  readonly title: string;
  readonly url: string;
  readonly stateCategory: RollupIssueStateCategory;
  readonly isAssignedToViewer?: boolean | undefined;
  readonly isMentioned?: boolean | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly commentCount?: number | undefined;
  readonly updatedAt: IsoDateTime;
}

export interface RollupIssueEntry extends RollupIssueInput {
  readonly canonicalKey: string;
  readonly sources: ReadonlyArray<RollupSourceRef>;
}

export type RollupThreadRole = "pm" | "cross_cutting" | "standard";
export type RollupThreadStatus =
  | "waiting_approval"
  | "waiting_input"
  | "error"
  | "running"
  | "idle"
  | "settled";

export interface RollupThreadInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly role?: RollupThreadRole | undefined;
  readonly status: RollupThreadStatus;
  readonly updatedAt: IsoDateTime;
}

export interface RollupThreadEntry {
  readonly canonicalKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly role: RollupThreadRole;
  readonly status: RollupThreadStatus;
  readonly updatedAt: IsoDateTime;
}

export interface MetaProjectRollupCounts {
  readonly pullRequests: {
    readonly total: number;
    readonly open: number;
    readonly draft: number;
    readonly failingChecks: number;
    readonly conflicting: number;
    readonly reviewRequested: number;
    readonly changesRequested: number;
    readonly approved: number;
    readonly merged: number;
    readonly closed: number;
  };
  readonly issues: {
    readonly total: number;
    readonly open: number;
    readonly closed: number;
    readonly assignedToViewer: number;
    readonly mentioned: number;
  };
  readonly threads: {
    readonly total: number;
    readonly active: number;
    readonly running: number;
    readonly needsAttention: number;
    readonly pm: number;
    readonly crossCutting: number;
    readonly standard: number;
    readonly settled: number;
  };
}

export interface MetaProjectRollupResult {
  readonly pullRequests: ReadonlyArray<RollupPullRequestEntry>;
  readonly issues: ReadonlyArray<RollupIssueEntry>;
  readonly activeThreads: ReadonlyArray<RollupThreadEntry>;
  readonly counts: MetaProjectRollupCounts;
}

export interface BuildMetaProjectRollupInput {
  readonly pullRequests: ReadonlyArray<RollupPullRequestInput>;
  readonly issues: ReadonlyArray<RollupIssueInput>;
  readonly threads: ReadonlyArray<RollupThreadInput>;
}

const makePullRequestCanonicalKey = (item: RollupPullRequestInput): string =>
  `${item.host.trim().toLowerCase()}\u0000${item.repository.trim().toLowerCase()}\u0000${item.number}`;

const makeIssueCanonicalKey = (item: RollupIssueInput): string =>
  `${item.tracker.trim().toLowerCase()}\u0000${item.host.trim().toLowerCase()}\u0000${item.scope.trim().toLowerCase()}\u0000${item.key.trim()}`;

const makeThreadCanonicalKey = (item: RollupThreadInput): string =>
  `${item.environmentId}\u0000${item.threadId}`;

const appendUniqueSource = (
  sources: ReadonlyArray<RollupSourceRef>,
  next: RollupSourceRef,
): ReadonlyArray<RollupSourceRef> => {
  const exists = sources.some(
    (s) => s.environmentId === next.environmentId && s.projectId === next.projectId,
  );
  if (exists) return sources;
  return [...sources, next].sort((left, right) => {
    const envDiff = left.environmentId.localeCompare(right.environmentId);
    if (envDiff !== 0) return envDiff;
    return left.projectId.localeCompare(right.projectId);
  });
};

const PR_STATE_RANK: Readonly<Record<RollupPullRequestState, number>> = {
  open: 0,
  merged: 1,
  closed: 2,
};

const computePullRequestUrgencyTier = (pr: RollupPullRequestEntry): number => {
  if (pr.state !== "open") return 5;
  if (pr.isDraft) return 4;
  if (pr.checksState === "failing" || pr.mergeability === "conflicting") return 0;
  if (pr.reviewDecision === "changes-requested" || pr.viewerReviewRequested === true) return 1;
  if (pr.reviewDecision === "review-required" || pr.checksState === "pending") return 2;
  return 3;
};

const comparePullRequests = (
  left: RollupPullRequestEntry,
  right: RollupPullRequestEntry,
): number => {
  const stateDiff = PR_STATE_RANK[left.state] - PR_STATE_RANK[right.state];
  if (stateDiff !== 0) return stateDiff;

  const urgencyDiff = computePullRequestUrgencyTier(left) - computePullRequestUrgencyTier(right);
  if (urgencyDiff !== 0) return urgencyDiff;

  const timeDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (timeDiff !== 0) return timeDiff;

  return left.canonicalKey.localeCompare(right.canonicalKey);
};

const ISSUE_STATE_RANK: Readonly<Record<RollupIssueStateCategory, number>> = {
  open: 0,
  closed: 1,
};

const computeIssueUrgencyTier = (issue: RollupIssueEntry): number => {
  if (issue.stateCategory !== "open") return 3;
  if (issue.isAssignedToViewer) return 0;
  if (issue.isMentioned) return 1;
  return 2;
};

const compareIssues = (left: RollupIssueEntry, right: RollupIssueEntry): number => {
  const stateDiff = ISSUE_STATE_RANK[left.stateCategory] - ISSUE_STATE_RANK[right.stateCategory];
  if (stateDiff !== 0) return stateDiff;

  const urgencyDiff = computeIssueUrgencyTier(left) - computeIssueUrgencyTier(right);
  if (urgencyDiff !== 0) return urgencyDiff;

  const timeDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (timeDiff !== 0) return timeDiff;

  return left.canonicalKey.localeCompare(right.canonicalKey);
};

const THREAD_ROLE_RANK: Readonly<Record<RollupThreadRole, number>> = {
  pm: 0,
  cross_cutting: 1,
  standard: 2,
};

const THREAD_STATUS_RANK: Readonly<Record<RollupThreadStatus, number>> = {
  waiting_approval: 0,
  waiting_input: 1,
  error: 2,
  running: 3,
  idle: 4,
  settled: 5,
};

const compareThreads = (left: RollupThreadEntry, right: RollupThreadEntry): number => {
  const roleDiff = THREAD_ROLE_RANK[left.role] - THREAD_ROLE_RANK[right.role];
  if (roleDiff !== 0) return roleDiff;

  const statusDiff = THREAD_STATUS_RANK[left.status] - THREAD_STATUS_RANK[right.status];
  if (statusDiff !== 0) return statusDiff;

  const timeDiff = right.updatedAt.localeCompare(left.updatedAt);
  if (timeDiff !== 0) return timeDiff;

  return left.canonicalKey.localeCompare(right.canonicalKey);
};

export function buildMetaProjectRollup(
  input: BuildMetaProjectRollupInput,
): MetaProjectRollupResult {
  const prByKey = new Map<string, RollupPullRequestEntry>();
  for (const item of input.pullRequests) {
    const canonicalKey = makePullRequestCanonicalKey(item);
    const source: RollupSourceRef = {
      environmentId: item.environmentId,
      projectId: item.projectId,
    };
    const existing = prByKey.get(canonicalKey);
    if (existing === undefined) {
      prByKey.set(canonicalKey, {
        ...item,
        canonicalKey,
        sources: [source],
      });
    } else {
      const isNewer = item.updatedAt.localeCompare(existing.updatedAt) > 0;
      const base = isNewer ? item : existing;
      prByKey.set(canonicalKey, {
        ...base,
        viewerReviewRequested:
          Boolean(existing.viewerReviewRequested) || Boolean(item.viewerReviewRequested),
        canonicalKey,
        sources: appendUniqueSource(existing.sources, source),
      });
    }
  }

  const issueByKey = new Map<string, RollupIssueEntry>();
  for (const item of input.issues) {
    const canonicalKey = makeIssueCanonicalKey(item);
    const source: RollupSourceRef = {
      environmentId: item.environmentId,
      projectId: item.projectId,
    };
    const existing = issueByKey.get(canonicalKey);
    if (existing === undefined) {
      issueByKey.set(canonicalKey, {
        ...item,
        canonicalKey,
        sources: [source],
      });
    } else {
      const isNewer = item.updatedAt.localeCompare(existing.updatedAt) > 0;
      const base = isNewer ? item : existing;
      issueByKey.set(canonicalKey, {
        ...base,
        isAssignedToViewer:
          Boolean(existing.isAssignedToViewer) || Boolean(item.isAssignedToViewer),
        isMentioned: Boolean(existing.isMentioned) || Boolean(item.isMentioned),
        canonicalKey,
        sources: appendUniqueSource(existing.sources, source),
      });
    }
  }

  const threadByKey = new Map<string, RollupThreadEntry>();
  for (const item of input.threads) {
    const canonicalKey = makeThreadCanonicalKey(item);
    const normalizedRole: RollupThreadRole = item.role ?? "standard";
    const existing = threadByKey.get(canonicalKey);
    if (existing === undefined) {
      threadByKey.set(canonicalKey, {
        canonicalKey,
        environmentId: item.environmentId,
        projectId: item.projectId,
        threadId: item.threadId,
        title: item.title,
        role: normalizedRole,
        status: item.status,
        updatedAt: item.updatedAt,
      });
    } else {
      const isNewer = item.updatedAt.localeCompare(existing.updatedAt) > 0;
      const higherRole =
        THREAD_ROLE_RANK[normalizedRole] < THREAD_ROLE_RANK[existing.role]
          ? normalizedRole
          : existing.role;
      const base = isNewer ? item : existing;
      threadByKey.set(canonicalKey, {
        canonicalKey,
        environmentId: base.environmentId,
        projectId: base.projectId,
        threadId: base.threadId,
        title: base.title,
        role: higherRole,
        status: base.status,
        updatedAt: base.updatedAt,
      });
    }
  }

  const pullRequests = [...prByKey.values()].sort(comparePullRequests);
  const issues = [...issueByKey.values()].sort(compareIssues);
  const allThreads = [...threadByKey.values()].sort(compareThreads);
  const activeThreads = allThreads.filter((thread) => thread.status !== "settled");

  let prOpen = 0;
  let prDraft = 0;
  let prFailingChecks = 0;
  let prConflicting = 0;
  let prReviewRequested = 0;
  let prChangesRequested = 0;
  let prApproved = 0;
  let prMerged = 0;
  let prClosed = 0;

  for (const pr of pullRequests) {
    if (pr.state === "open") {
      prOpen += 1;
      if (pr.isDraft) prDraft += 1;
      if (pr.checksState === "failing") prFailingChecks += 1;
      if (pr.mergeability === "conflicting") prConflicting += 1;
      if (pr.viewerReviewRequested) prReviewRequested += 1;
      if (pr.reviewDecision === "changes-requested") prChangesRequested += 1;
      if (pr.reviewDecision === "approved") prApproved += 1;
    } else if (pr.state === "merged") {
      prMerged += 1;
    } else {
      prClosed += 1;
    }
  }

  let issueOpen = 0;
  let issueClosed = 0;
  let issueAssigned = 0;
  let issueMentioned = 0;

  for (const issue of issues) {
    if (issue.stateCategory === "open") {
      issueOpen += 1;
      if (issue.isAssignedToViewer) issueAssigned += 1;
      if (issue.isMentioned) issueMentioned += 1;
    } else {
      issueClosed += 1;
    }
  }

  let threadRunning = 0;
  let threadNeedsAttention = 0;
  let threadPm = 0;
  let threadCrossCutting = 0;
  let threadStandard = 0;
  let threadSettled = 0;

  for (const thread of allThreads) {
    if (thread.status === "settled") {
      threadSettled += 1;
      continue;
    }
    if (thread.status === "running") {
      threadRunning += 1;
    } else if (
      thread.status === "waiting_approval" ||
      thread.status === "waiting_input" ||
      thread.status === "error"
    ) {
      threadNeedsAttention += 1;
    }

    if (thread.role === "pm") threadPm += 1;
    else if (thread.role === "cross_cutting") threadCrossCutting += 1;
    else threadStandard += 1;
  }

  return {
    pullRequests,
    issues,
    activeThreads,
    counts: {
      pullRequests: {
        total: pullRequests.length,
        open: prOpen,
        draft: prDraft,
        failingChecks: prFailingChecks,
        conflicting: prConflicting,
        reviewRequested: prReviewRequested,
        changesRequested: prChangesRequested,
        approved: prApproved,
        merged: prMerged,
        closed: prClosed,
      },
      issues: {
        total: issues.length,
        open: issueOpen,
        closed: issueClosed,
        assignedToViewer: issueAssigned,
        mentioned: issueMentioned,
      },
      threads: {
        total: allThreads.length,
        active: activeThreads.length,
        running: threadRunning,
        needsAttention: threadNeedsAttention,
        pm: threadPm,
        crossCutting: threadCrossCutting,
        standard: threadStandard,
        settled: threadSettled,
      },
    },
  };
}

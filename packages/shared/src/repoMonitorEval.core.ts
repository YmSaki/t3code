import type { ProjectId } from "@t3tools/contracts";

export type RepoMonitorEventKindValue =
  | "branch_push"
  | "pr_opened"
  | "pr_merged"
  | "pr_comment"
  | "issue_opened"
  | "issue_comment";

export interface RepoMonitorFilterCriteria {
  readonly branchGlobs?: ReadonlyArray<string> | undefined;
  readonly requiredLabels?: ReadonlyArray<string> | undefined;
  readonly excludedLabels?: ReadonlyArray<string> | undefined;
  readonly allowedAuthors?: ReadonlyArray<string> | undefined;
  readonly excludedAuthors?: ReadonlyArray<string> | undefined;
  readonly excludeBots?: boolean | undefined;
  readonly keywords?: ReadonlyArray<string> | undefined;
}

export interface RepoMonitorEvalRule {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly enabled: boolean;
  readonly eventKinds: ReadonlyArray<RepoMonitorEventKindValue>;
  readonly filter: RepoMonitorFilterCriteria;
}

export interface RepoMonitorCursorState {
  readonly projectId: ProjectId;
  readonly branchHeads: Readonly<Record<string, string>>;
  readonly knownPullRequestNumbers: ReadonlyArray<number>;
  readonly mergedPullRequestNumbers: ReadonlyArray<number>;
  readonly knownPullRequestCommentIds: ReadonlyArray<string>;
  readonly knownIssueKeys: ReadonlyArray<string>;
  readonly knownIssueCommentIds: ReadonlyArray<string>;
  readonly updatedAt: string;
}

export interface RepoMonitorBranchSnapshot {
  readonly name: string;
  readonly headSha: string;
  readonly authorLogin?: string | null;
  readonly isBot?: boolean;
  readonly commitMessage?: string;
  readonly url?: string | null;
  readonly updatedAt?: string;
}

export interface RepoMonitorCommentSnapshot {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly isBot?: boolean;
  readonly body: string;
  readonly createdAt: string;
  readonly url?: string | null;
  readonly path?: string | null;
}

export interface RepoMonitorPullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  readonly url?: string | null;
  readonly state: "open" | "closed" | "merged";
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha?: string | null;
  readonly authorLogin: string | null;
  readonly isBot?: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt?: string | null;
  readonly comments?: ReadonlyArray<RepoMonitorCommentSnapshot>;
}

export interface RepoMonitorIssueSnapshot {
  readonly key: string;
  readonly title: string;
  readonly body?: string;
  readonly url?: string | null;
  readonly stateCategory: "open" | "closed";
  readonly authorLogin: string | null;
  readonly isBot?: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly comments?: ReadonlyArray<RepoMonitorCommentSnapshot>;
}

export interface RepoMonitorSnapshot {
  readonly projectId: ProjectId;
  readonly observedAt: string;
  readonly branches: ReadonlyArray<RepoMonitorBranchSnapshot>;
  readonly pullRequests: ReadonlyArray<RepoMonitorPullRequestSnapshot>;
  readonly issues: ReadonlyArray<RepoMonitorIssueSnapshot>;
}

export interface RepoMonitorCandidateEvent {
  readonly kind: RepoMonitorEventKindValue;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly body: string;
  readonly authorLogin: string | null;
  readonly isBot: boolean;
  readonly labels: ReadonlyArray<string>;
  readonly branch: string | null;
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
  readonly previousCommitSha: string | null;
  readonly commitSha: string | null;
  readonly pullRequestNumber: number | null;
  readonly issueKey: string | null;
  readonly commentId: string | null;
  readonly path: string | null;
  readonly url: string | null;
  readonly occurredAt: string;
}

export interface RepoMonitorRuleMatch {
  readonly ruleId: string;
  readonly event: RepoMonitorCandidateEvent;
}

export interface RepoMonitorEvalResult {
  readonly candidateEvents: ReadonlyArray<RepoMonitorCandidateEvent>;
  readonly matches: ReadonlyArray<RepoMonitorRuleMatch>;
  readonly nextCursor: RepoMonitorCursorState;
}

export function createEmptyRepoMonitorCursor(
  projectId: ProjectId,
  updatedAt: string,
): RepoMonitorCursorState {
  return {
    projectId,
    branchHeads: {},
    knownPullRequestNumbers: [],
    mergedPullRequestNumbers: [],
    knownPullRequestCommentIds: [],
    knownIssueKeys: [],
    knownIssueCommentIds: [],
    updatedAt,
  };
}

export function isBotActor(authorLogin: string | null, isBotFlag?: boolean): boolean {
  if (isBotFlag === true) return true;
  if (!authorLogin) return false;
  const normalized = authorLogin.trim().toLowerCase();
  return normalized.endsWith("[bot]") || normalized.endsWith("-bot");
}

function globToRegExp(glob: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          regex += "(?:.+/)?";
          i += 3;
          continue;
        }
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    if ("\\^$.+()[]{}|".includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i += 1;
  }
  regex += "$";
  return new RegExp(regex);
}

export function matchBranchGlob(pattern: string, branchName: string): boolean {
  const trimmedPattern = pattern.trim();
  const trimmedBranch = branchName.trim();
  if (trimmedPattern.length === 0 || trimmedBranch.length === 0) return false;
  return globToRegExp(trimmedPattern).test(trimmedBranch);
}

export function buildNextRepoMonitorCursor(
  previousCursor: RepoMonitorCursorState | null | undefined,
  snapshot: RepoMonitorSnapshot,
): RepoMonitorCursorState {
  const branchHeads: Record<string, string> = {
    ...previousCursor?.branchHeads,
  };
  for (const branch of snapshot.branches) {
    branchHeads[branch.name] = branch.headSha;
  }

  const knownPrs = new Set<number>(previousCursor?.knownPullRequestNumbers ?? []);
  const mergedPrs = new Set<number>(previousCursor?.mergedPullRequestNumbers ?? []);
  const knownPrComments = new Set<string>(previousCursor?.knownPullRequestCommentIds ?? []);

  for (const pr of snapshot.pullRequests) {
    knownPrs.add(pr.number);
    if (pr.state === "merged" || Boolean(pr.mergedAt)) {
      mergedPrs.add(pr.number);
    }
    for (const comment of pr.comments ?? []) {
      knownPrComments.add(comment.id);
    }
  }

  const knownIssues = new Set<string>(previousCursor?.knownIssueKeys ?? []);
  const knownIssueComments = new Set<string>(previousCursor?.knownIssueCommentIds ?? []);

  for (const issue of snapshot.issues) {
    knownIssues.add(issue.key);
    for (const comment of issue.comments ?? []) {
      knownIssueComments.add(comment.id);
    }
  }

  return {
    projectId: snapshot.projectId,
    branchHeads,
    knownPullRequestNumbers: [...knownPrs].sort((a, b) => a - b),
    mergedPullRequestNumbers: [...mergedPrs].sort((a, b) => a - b),
    knownPullRequestCommentIds: [...knownPrComments].sort(),
    knownIssueKeys: [...knownIssues].sort(),
    knownIssueCommentIds: [...knownIssueComments].sort(),
    updatedAt: snapshot.observedAt,
  };
}

export function extractNewRepoMonitorEvents(
  previousCursor: RepoMonitorCursorState | null | undefined,
  snapshot: RepoMonitorSnapshot,
  options?: { readonly emitOnInitialCursor?: boolean },
): ReadonlyArray<RepoMonitorCandidateEvent> {
  if (!previousCursor && !options?.emitOnInitialCursor) {
    return [];
  }

  const prevBranches = previousCursor?.branchHeads ?? {};
  const knownPrs = new Set<number>(previousCursor?.knownPullRequestNumbers ?? []);
  const mergedPrs = new Set<number>(previousCursor?.mergedPullRequestNumbers ?? []);
  const knownPrComments = new Set<string>(previousCursor?.knownPullRequestCommentIds ?? []);
  const knownIssues = new Set<string>(previousCursor?.knownIssueKeys ?? []);
  const knownIssueComments = new Set<string>(previousCursor?.knownIssueCommentIds ?? []);

  const events: RepoMonitorCandidateEvent[] = [];

  for (const branch of snapshot.branches) {
    const previousSha = Object.hasOwn(prevBranches, branch.name)
      ? prevBranches[branch.name]!
      : null;
    if (previousSha !== branch.headSha) {
      const authorLogin = branch.authorLogin ?? null;
      events.push({
        kind: "branch_push",
        projectId: snapshot.projectId,
        title: branch.commitMessage ?? `Push to ${branch.name}`,
        body: branch.commitMessage ?? "",
        authorLogin,
        isBot: isBotActor(authorLogin, branch.isBot),
        labels: [],
        branch: branch.name,
        headBranch: branch.name,
        baseBranch: null,
        previousCommitSha: previousSha,
        commitSha: branch.headSha,
        pullRequestNumber: null,
        issueKey: null,
        commentId: null,
        path: null,
        url: branch.url ?? null,
        occurredAt: branch.updatedAt ?? snapshot.observedAt,
      });
    }
  }

  for (const pr of snapshot.pullRequests) {
    const isMerged = pr.state === "merged" || Boolean(pr.mergedAt);
    if (!knownPrs.has(pr.number) && pr.state === "open") {
      events.push({
        kind: "pr_opened",
        projectId: snapshot.projectId,
        title: pr.title,
        body: pr.body ?? "",
        authorLogin: pr.authorLogin,
        isBot: isBotActor(pr.authorLogin, pr.isBot),
        labels: pr.labels,
        branch: pr.headBranch,
        headBranch: pr.headBranch,
        baseBranch: pr.baseBranch,
        previousCommitSha: null,
        commitSha: pr.headSha ?? null,
        pullRequestNumber: pr.number,
        issueKey: null,
        commentId: null,
        path: null,
        url: pr.url ?? null,
        occurredAt: pr.createdAt,
      });
    }

    if (!mergedPrs.has(pr.number) && isMerged) {
      events.push({
        kind: "pr_merged",
        projectId: snapshot.projectId,
        title: pr.title,
        body: pr.body ?? "",
        authorLogin: pr.authorLogin,
        isBot: isBotActor(pr.authorLogin, pr.isBot),
        labels: pr.labels,
        branch: pr.baseBranch,
        headBranch: pr.headBranch,
        baseBranch: pr.baseBranch,
        previousCommitSha: null,
        commitSha: pr.headSha ?? null,
        pullRequestNumber: pr.number,
        issueKey: null,
        commentId: null,
        path: null,
        url: pr.url ?? null,
        occurredAt: pr.mergedAt ?? pr.updatedAt,
      });
    }

    for (const comment of pr.comments ?? []) {
      if (!knownPrComments.has(comment.id)) {
        events.push({
          kind: "pr_comment",
          projectId: snapshot.projectId,
          title: pr.title,
          body: comment.body,
          authorLogin: comment.authorLogin,
          isBot: isBotActor(comment.authorLogin, comment.isBot),
          labels: pr.labels,
          branch: pr.headBranch,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          previousCommitSha: null,
          commitSha: pr.headSha ?? null,
          pullRequestNumber: pr.number,
          issueKey: null,
          commentId: comment.id,
          path: comment.path ?? null,
          url: comment.url ?? pr.url ?? null,
          occurredAt: comment.createdAt,
        });
      }
    }
  }

  for (const issue of snapshot.issues) {
    if (!knownIssues.has(issue.key) && issue.stateCategory === "open") {
      events.push({
        kind: "issue_opened",
        projectId: snapshot.projectId,
        title: issue.title,
        body: issue.body ?? "",
        authorLogin: issue.authorLogin,
        isBot: isBotActor(issue.authorLogin, issue.isBot),
        labels: issue.labels,
        branch: null,
        headBranch: null,
        baseBranch: null,
        previousCommitSha: null,
        commitSha: null,
        pullRequestNumber: null,
        issueKey: issue.key,
        commentId: null,
        path: null,
        url: issue.url ?? null,
        occurredAt: issue.createdAt,
      });
    }

    for (const comment of issue.comments ?? []) {
      if (!knownIssueComments.has(comment.id)) {
        events.push({
          kind: "issue_comment",
          projectId: snapshot.projectId,
          title: issue.title,
          body: comment.body,
          authorLogin: comment.authorLogin,
          isBot: isBotActor(comment.authorLogin, comment.isBot),
          labels: issue.labels,
          branch: null,
          headBranch: null,
          baseBranch: null,
          previousCommitSha: null,
          commitSha: null,
          pullRequestNumber: null,
          issueKey: issue.key,
          commentId: comment.id,
          path: comment.path ?? null,
          url: comment.url ?? issue.url ?? null,
          occurredAt: comment.createdAt,
        });
      }
    }
  }

  return events;
}

export function matchesRepoMonitorFilter(
  event: RepoMonitorCandidateEvent,
  filter: RepoMonitorFilterCriteria,
): boolean {
  if (filter.excludeBots === true && isBotActor(event.authorLogin, event.isBot)) {
    return false;
  }

  if (filter.branchGlobs && filter.branchGlobs.length > 0) {
    const candidateBranches = [event.branch, event.headBranch, event.baseBranch].filter(
      (b): b is string => typeof b === "string" && b.length > 0,
    );
    if (candidateBranches.length === 0) {
      return false;
    }
    const matchedBranch = filter.branchGlobs.some((pattern) =>
      candidateBranches.some((branchName) => matchBranchGlob(pattern, branchName)),
    );
    if (!matchedBranch) {
      return false;
    }
  }

  const eventLabelSet = new Set(event.labels.map((label) => label.trim().toLowerCase()));

  if (filter.requiredLabels && filter.requiredLabels.length > 0) {
    const hasAllRequired = filter.requiredLabels.every((req) =>
      eventLabelSet.has(req.trim().toLowerCase()),
    );
    if (!hasAllRequired) {
      return false;
    }
  }

  if (filter.excludedLabels && filter.excludedLabels.length > 0) {
    const hasAnyExcluded = filter.excludedLabels.some((excl) =>
      eventLabelSet.has(excl.trim().toLowerCase()),
    );
    if (hasAnyExcluded) {
      return false;
    }
  }

  const normalizedAuthor = event.authorLogin ? event.authorLogin.trim().toLowerCase() : null;

  if (filter.allowedAuthors && filter.allowedAuthors.length > 0) {
    if (!normalizedAuthor) return false;
    const isAllowed = filter.allowedAuthors.some(
      (author) => author.trim().toLowerCase() === normalizedAuthor,
    );
    if (!isAllowed) {
      return false;
    }
  }

  if (filter.excludedAuthors && filter.excludedAuthors.length > 0 && normalizedAuthor) {
    const isExcluded = filter.excludedAuthors.some(
      (author) => author.trim().toLowerCase() === normalizedAuthor,
    );
    if (isExcluded) {
      return false;
    }
  }

  if (filter.keywords && filter.keywords.length > 0) {
    const nonEmptyKeywords = filter.keywords
      .map((kw) => kw.trim().toLowerCase())
      .filter((kw) => kw.length > 0);
    if (nonEmptyKeywords.length > 0) {
      const searchable = `${event.title}\n${event.body}`.toLowerCase();
      const hasKeyword = nonEmptyKeywords.some((kw) => searchable.includes(kw));
      if (!hasKeyword) {
        return false;
      }
    }
  }

  return true;
}

export function evaluateRepoMonitorSnapshot(input: {
  readonly previousCursor: RepoMonitorCursorState | null | undefined;
  readonly snapshot: RepoMonitorSnapshot;
  readonly rules: ReadonlyArray<RepoMonitorEvalRule>;
  readonly emitOnInitialCursor?: boolean;
}): RepoMonitorEvalResult {
  const candidateEvents = extractNewRepoMonitorEvents(
    input.previousCursor,
    input.snapshot,
    input.emitOnInitialCursor !== undefined
      ? { emitOnInitialCursor: input.emitOnInitialCursor }
      : undefined,
  );
  const nextCursor = buildNextRepoMonitorCursor(input.previousCursor, input.snapshot);

  const matches: RepoMonitorRuleMatch[] = [];
  for (const rule of input.rules) {
    if (!rule.enabled || rule.projectId !== input.snapshot.projectId) {
      continue;
    }
    const kindSet = new Set<RepoMonitorEventKindValue>(rule.eventKinds);
    for (const event of candidateEvents) {
      if (!kindSet.has(event.kind)) {
        continue;
      }
      if (matchesRepoMonitorFilter(event, rule.filter)) {
        matches.push({ ruleId: rule.id, event });
      }
    }
  }

  return {
    candidateEvents,
    matches,
    nextCursor,
  };
}

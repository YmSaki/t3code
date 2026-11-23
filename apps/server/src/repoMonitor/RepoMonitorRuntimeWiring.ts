import {
  CommandId,
  MessageId,
  type ProjectId,
  RepoMonitorError,
  type RepoMonitorEventKind,
  type RepoMonitorEventRecord,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  RepoMonitorBranchSnapshot,
  RepoMonitorCandidateEvent,
  RepoMonitorIssueSnapshot,
  RepoMonitorPullRequestSnapshot,
  RepoMonitorSnapshot,
} from "@t3tools/shared/repoMonitorEval.core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as IssueService from "../issue/IssueService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as WebPushService from "../push/WebPushService.ts";
import { verifyWebhookSignature } from "../scheduledTasks/webhookVerification.ts";
import * as BranchHeadProber from "./BranchHeadProber.ts";
import {
  type RepoMonitorActionDispatcher,
  type RepoMonitorActionDispatchInput,
  RepoMonitorService,
  make as makeRepoMonitorService,
} from "./RepoMonitorService.ts";
import { RepoMonitorStore } from "./RepoMonitorStore.ts";

const PULL_REQUEST_LIMIT = 100;
const ISSUE_LIMIT = 100;

export interface RepoMonitorObservation {
  readonly snapshot: RepoMonitorSnapshot;
  /** Accounts this environment acts as on the forge, so its own pushes and comments never retrigger it. */
  readonly selfAccountLogins: ReadonlyArray<string>;
}

/** Reads a project's repository as the monitor sees it. */
export class RepoMonitorSnapshotSource extends Context.Service<
  RepoMonitorSnapshotSource,
  {
    readonly observe: (
      projectId: ProjectId,
    ) => Effect.Effect<RepoMonitorObservation, RepoMonitorError>;
    /** The forge accounts the last observation saw, for webhooks that carry no viewer. */
    readonly lastSelfAccountLogins: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/repoMonitor/RepoMonitorRuntimeWiring/RepoMonitorSnapshotSource") {}

export interface RepoMonitorSnapshotPorts {
  readonly workspaceRoot: (projectId: ProjectId) => Effect.Effect<string | null, RepoMonitorError>;
  readonly branches: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<RepoMonitorBranchSnapshot>, RepoMonitorError>;
  readonly pullRequests: (projectId: ProjectId) => Effect.Effect<
    {
      readonly entries: ReadonlyArray<RepoMonitorPullRequestSnapshot>;
      readonly viewers: ReadonlyArray<string>;
    },
    RepoMonitorError
  >;
  readonly issues: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<RepoMonitorIssueSnapshot>, RepoMonitorError>;
}

export const makeSnapshotSource = (ports: RepoMonitorSnapshotPorts) => {
  const selfLogins = new Map<ProjectId, ReadonlyArray<string>>();
  return RepoMonitorSnapshotSource.of({
    lastSelfAccountLogins: Effect.fn("RepoMonitorSnapshotSource.lastSelfAccountLogins")(
      (projectId: ProjectId) => Effect.sync(() => selfLogins.get(projectId) ?? []),
    ),
    observe: Effect.fn("RepoMonitorSnapshotSource.observe")(function* (projectId) {
      const cwd = yield* ports.workspaceRoot(projectId);
      if (cwd === null) {
        return yield* new RepoMonitorError({ message: `Project ${projectId} was not found.` });
      }
      // The cursor only ever adds what it has seen, so a forge that is down this poll loses
      // nothing: its pull requests and issues show up as new once it answers again.
      const forgeDown = (what: string) => (error: RepoMonitorError) =>
        Effect.logWarning(`repo monitor could not list ${what}`, { projectId, error });
      const [branches, pullRequests, issues] = yield* Effect.all(
        [
          ports.branches(cwd),
          ports
            .pullRequests(projectId)
            .pipe(
              Effect.catch((error) =>
                forgeDown("pull requests")(error).pipe(Effect.as({ entries: [], viewers: [] })),
              ),
            ),
          ports
            .issues(projectId)
            .pipe(Effect.catch((error) => forgeDown("issues")(error).pipe(Effect.as([])))),
        ],
        { concurrency: "unbounded" },
      );
      if (pullRequests.viewers.length > 0) selfLogins.set(projectId, pullRequests.viewers);
      return {
        snapshot: {
          projectId,
          observedAt: DateTime.formatIso(yield* DateTime.now),
          branches,
          pullRequests: pullRequests.entries,
          issues,
        },
        selfAccountLogins: pullRequests.viewers,
      };
    }),
  });
};

const toRepoMonitorError = (message: string) => (cause: unknown) =>
  new RepoMonitorError({ message, cause });

export const snapshotSourceLayer = Layer.effect(
  RepoMonitorSnapshotSource,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const prober = yield* BranchHeadProber.BranchHeadProber;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const issues = yield* IssueService.IssueService;
    return makeSnapshotSource({
      workspaceRoot: (projectId) =>
        projects
          .get(projectId)
          .pipe(
            Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.workspaceRoot })),
            Effect.mapError(toRepoMonitorError(`Could not read project ${projectId}.`)),
          ),
      branches: (cwd) => prober.probeHeads({ cwd }),
      pullRequests: (projectId) =>
        pullRequests.list({ projectId, state: "all", limit: PULL_REQUEST_LIMIT }).pipe(
          Effect.map((listed) => ({
            viewers: Object.values(listed.viewers),
            entries: listed.entries.map((entry): RepoMonitorPullRequestSnapshot => ({
              number: entry.number,
              title: entry.title,
              url: entry.url,
              state: entry.state,
              headBranch: entry.headBranch,
              baseBranch: entry.baseBranch,
              authorLogin: entry.author?.login ?? null,
              isBot: entry.author?.isBot ?? false,
              labels: entry.labels.map((label) => label.name),
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
            })),
          })),
          Effect.mapError(toRepoMonitorError("Could not list pull requests.")),
        ),
      issues: (projectId) =>
        issues.list({ projectId, state: "open", limit: ISSUE_LIMIT }).pipe(
          Effect.map((listed) =>
            listed.entries.map((entry): RepoMonitorIssueSnapshot => ({
              key: entry.key,
              title: entry.title,
              url: entry.url,
              stateCategory: entry.state.category,
              authorLogin: entry.author?.login ?? null,
              isBot: entry.author?.isBot ?? false,
              labels: entry.labels.map((label) => label.name),
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
            })),
          ),
          Effect.mapError(toRepoMonitorError("Could not list issues.")),
        ),
    });
  }),
);

export interface RepoMonitorDispatchPorts {
  readonly notifyPm: (
    input: RepoMonitorActionDispatchInput,
  ) => Effect.Effect<void, RepoMonitorError>;
  readonly launchThread: (
    input: RepoMonitorActionDispatchInput,
  ) => Effect.Effect<ThreadId, RepoMonitorError>;
  readonly sendToThread: (
    input: RepoMonitorActionDispatchInput & { readonly threadId: ThreadId },
  ) => Effect.Effect<void, RepoMonitorError>;
}

export const makeActionDispatcher =
  (ports: RepoMonitorDispatchPorts): RepoMonitorActionDispatcher =>
  (input) => {
    switch (input.rule.actionKind) {
      case "notify_pm":
        return ports.notifyPm(input).pipe(Effect.as({ dispatchedThreadId: null }));
      case "launch_thread":
        return ports
          .launchThread(input)
          .pipe(Effect.map((dispatchedThreadId) => ({ dispatchedThreadId })));
      case "send_to_thread": {
        const threadId = input.rule.targetThreadId;
        if (threadId == null) {
          return Effect.fail(
            new RepoMonitorError({
              message: `Rule "${input.rule.name}" sends to a thread but names none.`,
              ruleId: input.rule.id,
            }),
          );
        }
        return ports
          .sendToThread({ ...input, threadId })
          .pipe(Effect.as({ dispatchedThreadId: threadId }));
      }
    }
  };

/** The same dedupe key replays the same command, so a retried poll cannot start two threads. */
const commandIdFor = (input: RepoMonitorActionDispatchInput) =>
  CommandId.make(`repo-monitor:${input.dedupeKey}`);
const messageIdFor = (input: RepoMonitorActionDispatchInput) =>
  MessageId.make(`repo-monitor-message:${input.dedupeKey}`);

const dispatchPortsLive = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const push = yield* WebPushService.WebPushService;
  return {
    notifyPm: (input) =>
      push
        .notifyEvent({
          kind: "repo_monitor_triggered",
          projectId: input.rule.projectId,
          monitorRuleName: input.rule.name,
          findingSummary: input.event.title,
          occurredAt: input.event.occurredAt,
        })
        .pipe(Effect.asVoid, Effect.mapError(toRepoMonitorError("Could not notify."))),
    launchThread: Effect.fn("RepoMonitorDispatch.launchThread")(function* (input) {
      const project = yield* projects
        .get(input.rule.projectId)
        .pipe(Effect.mapError(toRepoMonitorError("Could not read the rule's project.")));
      const modelSelection = Option.getOrNull(project)?.defaultModelSelection ?? null;
      if (modelSelection === null) {
        return yield* new RepoMonitorError({
          message: `Project ${input.rule.projectId} has no default model to launch a thread with.`,
          ruleId: input.rule.id,
        });
      }
      const launched = yield* threadLaunch
        .launch({
          commandId: commandIdFor(input),
          projectId: input.rule.projectId,
          title: input.rule.name,
          modelSelection,
          runtimeMode: input.rule.runtimeMode ?? "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: messageIdFor(input),
            text: input.renderedPrompt,
            attachments: [],
          },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.mapError(toRepoMonitorError("Could not launch the rule's thread.")));
      return launched.threadId;
    }),
    sendToThread: (input) =>
      threadManagement
        .sendToThread({
          projectId: input.rule.projectId,
          commandId: commandIdFor(input),
          threadId: input.threadId,
          messageId: messageIdFor(input),
          text: input.renderedPrompt,
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.asVoid, Effect.mapError(toRepoMonitorError("Could not send to the thread."))),
  } satisfies RepoMonitorDispatchPorts;
});

/**
 * `RepoMonitorService` with real git, forge and thread wiring. Provide
 * `snapshotSourceLayer` (or a test source) alongside; the loop reads it too.
 */
export const layer = Layer.effect(
  RepoMonitorService,
  Effect.gen(function* () {
    const source = yield* RepoMonitorSnapshotSource;
    const ports = yield* dispatchPortsLive;
    return yield* makeRepoMonitorService({
      snapshotProvider: (projectId) =>
        source.observe(projectId).pipe(Effect.map((observed) => observed.snapshot)),
      onActionTriggered: makeActionDispatcher(ports),
    });
  }),
);

/** One pass over every project with an enabled rule, one project at a time. */
export const runRepoMonitorPollCycle = Effect.fn("RepoMonitorRuntimeWiring.pollCycle")(
  function* () {
    const store = yield* RepoMonitorStore;
    const service = yield* RepoMonitorService;
    const source = yield* RepoMonitorSnapshotSource;
    const rules = yield* store.listRules();
    const projectIds = [...new Set(rules.filter((r) => r.enabled).map((r) => r.projectId))];
    const triggered: RepoMonitorEventRecord[] = [];
    for (const projectId of projectIds) {
      yield* source.observe(projectId).pipe(
        Effect.flatMap((observed) =>
          service.pollProject({
            projectId,
            snapshot: observed.snapshot,
            selfAccountLogins: observed.selfAccountLogins,
          }),
        ),
        Effect.tap((result) => Effect.sync(() => triggered.push(...result.triggeredEvents))),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("repo monitor poll failed", { projectId, cause }),
        ),
      );
    }
    return triggered;
  },
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) =>
      Effect.logWarning("repo monitor could not list its rules", { cause }).pipe(
        Effect.as<ReadonlyArray<RepoMonitorEventRecord>>([]),
      ),
  ),
);

/** Mount point for the server: polls every `interval` until the enclosing scope closes. */
export const startRepoMonitorLoop = (interval: Duration.Input) =>
  Effect.forkScoped(runRepoMonitorPollCycle().pipe(Effect.repeat(Schedule.spaced(interval))));

const GitHubActor = Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) });
const GitHubLabel = Schema.Struct({ name: Schema.String });
const GitHubIssueFields = {
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  user: Schema.optional(Schema.NullOr(GitHubActor)),
  labels: Schema.optional(Schema.Array(GitHubLabel)),
  updated_at: Schema.optional(Schema.String),
};

const GitHubPush = Schema.Struct({
  ref: Schema.String,
  before: Schema.optional(Schema.String),
  after: Schema.String,
  compare: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
  head_commit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ message: Schema.String, timestamp: Schema.optional(Schema.String) }),
    ),
  ),
  sender: Schema.optional(GitHubActor),
});
const GitHubPullRequest = Schema.Struct({
  action: Schema.String,
  pull_request: Schema.Struct({
    ...GitHubIssueFields,
    merged: Schema.optional(Schema.Boolean),
    head: Schema.Struct({ ref: Schema.String }),
    base: Schema.Struct({ ref: Schema.String }),
  }),
});
const GitHubIssues = Schema.Struct({
  action: Schema.String,
  issue: Schema.Struct(GitHubIssueFields),
});
const GitHubIssueComment = Schema.Struct({
  action: Schema.String,
  issue: Schema.Struct({ ...GitHubIssueFields, pull_request: Schema.optional(Schema.Unknown) }),
  comment: Schema.Struct({
    id: Schema.Number,
    body: Schema.String,
    html_url: Schema.String,
    user: Schema.optional(Schema.NullOr(GitHubActor)),
    created_at: Schema.String,
  }),
});
const decodePush = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubPush));
const decodePullRequest = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubPullRequest));
const decodeIssues = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubIssues));
const decodeIssueComment = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubIssueComment));

const emptyEvent = (
  kind: RepoMonitorEventKind,
  projectId: ProjectId,
  occurredAt: string,
): RepoMonitorCandidateEvent => ({
  kind,
  projectId,
  title: "",
  body: "",
  authorLogin: null,
  isBot: false,
  labels: [],
  branch: null,
  headBranch: null,
  baseBranch: null,
  previousCommitSha: null,
  commitSha: null,
  pullRequestNumber: null,
  issueKey: null,
  commentId: null,
  path: null,
  url: null,
  occurredAt,
});

const actorFields = (actor: typeof GitHubActor.Type | null | undefined) => ({
  authorLogin: actor?.login ?? null,
  isBot: actor?.type === "Bot",
});

/** The monitor event a GitHub delivery stands for, or null for deliveries it does not watch. */
export function parseGitHubWebhookEvent(input: {
  readonly projectId: ProjectId;
  readonly githubEvent: string;
  readonly body: string;
  readonly receivedAt: string;
}): RepoMonitorCandidateEvent | null {
  const { projectId, receivedAt } = input;
  switch (input.githubEvent) {
    case "push": {
      const push = Option.getOrNull(decodePush(input.body));
      if (push === null || push.deleted === true || !push.ref.startsWith("refs/heads/"))
        return null;
      const branch = push.ref.slice("refs/heads/".length);
      return {
        ...emptyEvent("branch_push", projectId, push.head_commit?.timestamp ?? receivedAt),
        ...actorFields(push.sender),
        title: push.head_commit?.message.split("\n")[0] ?? `Push to ${branch}`,
        body: push.head_commit?.message ?? "",
        branch,
        headBranch: branch,
        // A new branch's `before` is all zeros: there was no previous head.
        previousCommitSha:
          push.before === undefined || /^0+$/.test(push.before) ? null : push.before,
        commitSha: push.after,
        url: push.compare ?? null,
      };
    }
    case "pull_request": {
      const delivery = Option.getOrNull(decodePullRequest(input.body));
      if (delivery === null) return null;
      const pr = delivery.pull_request;
      const kind =
        delivery.action === "opened"
          ? "pr_opened"
          : delivery.action === "closed" && pr.merged === true
            ? "pr_merged"
            : null;
      if (kind === null) return null;
      return {
        ...emptyEvent(kind, projectId, pr.updated_at ?? receivedAt),
        ...actorFields(pr.user),
        title: pr.title,
        body: pr.body ?? "",
        labels: (pr.labels ?? []).map((label) => label.name),
        // Same fields the poll derives, so both paths build one dedupe key for one PR event.
        branch: kind === "pr_merged" ? pr.base.ref : pr.head.ref,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        pullRequestNumber: pr.number,
        url: pr.html_url,
      };
    }
    case "issues": {
      const delivery = Option.getOrNull(decodeIssues(input.body));
      if (delivery === null || delivery.action !== "opened") return null;
      const issue = delivery.issue;
      return {
        ...emptyEvent("issue_opened", projectId, issue.updated_at ?? receivedAt),
        ...actorFields(issue.user),
        title: issue.title,
        body: issue.body ?? "",
        labels: (issue.labels ?? []).map((label) => label.name),
        issueKey: String(issue.number),
        url: issue.html_url,
      };
    }
    case "issue_comment": {
      const delivery = Option.getOrNull(decodeIssueComment(input.body));
      if (delivery === null || delivery.action !== "created") return null;
      const { issue, comment } = delivery;
      const onPullRequest = issue.pull_request !== undefined;
      return {
        ...emptyEvent(
          onPullRequest ? "pr_comment" : "issue_comment",
          projectId,
          comment.created_at,
        ),
        ...actorFields(comment.user),
        title: issue.title,
        body: comment.body,
        labels: (issue.labels ?? []).map((label) => label.name),
        pullRequestNumber: onPullRequest ? issue.number : null,
        issueKey: onPullRequest ? null : String(issue.number),
        commentId: String(comment.id),
        url: comment.html_url,
      };
    }
    default:
      return null;
  }
}

const GITHUB_SIGNATURE = {
  header: "x-hub-signature-256",
  encoding: "hex",
  prefix: "sha256=",
} as const;

export type RepoMonitorWebhookOutcome =
  | { readonly status: "unauthorized" }
  | { readonly status: "ignored" }
  | { readonly status: "accepted"; readonly events: ReadonlyArray<RepoMonitorEventRecord> };

/**
 * Handles one GitHub webhook delivery for a project. Headers are lowercased; the body is
 * the raw bytes the signature covers. A delivery with no valid signature changes nothing.
 */
export const handleRepoMonitorWebhook = Effect.fn("RepoMonitorRuntimeWiring.handleWebhook")(
  function* (request: {
    readonly projectId: ProjectId;
    readonly secret: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  }) {
    const verified = yield* verifyWebhookSignature({
      signature: GITHUB_SIGNATURE,
      secret: request.secret,
      headers: request.headers,
      body: request.body,
    });
    if (!verified) return { status: "unauthorized" } satisfies RepoMonitorWebhookOutcome;

    const event = parseGitHubWebhookEvent({
      projectId: request.projectId,
      githubEvent: request.headers["x-github-event"] ?? "",
      body: new TextDecoder().decode(request.body),
      receivedAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (event === null) return { status: "ignored" } satisfies RepoMonitorWebhookOutcome;

    const service = yield* RepoMonitorService;
    const source = yield* RepoMonitorSnapshotSource;
    const events = yield* service.ingestWebhookEvent({
      projectId: request.projectId,
      event,
      selfAccountLogins: yield* source.lastSelfAccountLogins(request.projectId),
    });
    return { status: "accepted", events } satisfies RepoMonitorWebhookOutcome;
  },
);

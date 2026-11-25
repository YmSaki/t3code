// @effect-diagnostics-next-line nodeBuiltinImport:off -- Node's HMAC signs deliveries the way GitHub does.
import * as NodeCrypto from "node:crypto";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RepoMonitorError,
  type RepoMonitorRule,
  RepoMonitorRuleId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type {
  RepoMonitorBranchSnapshot,
  RepoMonitorIssueSnapshot,
} from "@t3tools/shared/repoMonitorEval.core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import Migration0109 from "../persistence/Migrations/109_RepoMonitors.ts";
import * as RepoMonitorRuntimeWiring from "./RepoMonitorRuntimeWiring.ts";
import type { RepoMonitorActionDispatchInput } from "./RepoMonitorService.ts";
import * as RepoMonitorService from "./RepoMonitorService.ts";
import { layer as repoMonitorStoreLayer } from "./RepoMonitorStore.ts";

const PROJECT_ID = ProjectId.make("proj-1");
const LAUNCHED = ThreadId.make("thread-launched");
const SECRET = "hook-secret";

const makeHarness = () => {
  const state = {
    heads: [{ name: "main", headSha: "sha-1" }] as ReadonlyArray<RepoMonitorBranchSnapshot>,
    /** null: the forge cannot be read. */
    viewers: null as ReadonlyArray<string> | null,
    issues: [] as ReadonlyArray<RepoMonitorIssueSnapshot>,
    failLaunch: false,
  };
  const dispatched: Array<{ kind: string; input: RepoMonitorActionDispatchInput }> = [];
  const ports: RepoMonitorRuntimeWiring.RepoMonitorDispatchPorts = {
    notifyPm: (input) => Effect.sync(() => void dispatched.push({ kind: "notify_pm", input })),
    launchThread: (input) =>
      state.failLaunch
        ? Effect.fail(new RepoMonitorError({ message: "no default model" }))
        : Effect.sync(() => dispatched.push({ kind: "launch_thread", input })).pipe(
            Effect.as(LAUNCHED),
          ),
    sendToThread: (input) => Effect.sync(() => void dispatched.push({ kind: "send", input })),
  };
  const source = RepoMonitorRuntimeWiring.makeSnapshotSource({
    workspaceRoot: (projectId) => Effect.succeed(projectId === PROJECT_ID ? "/work/repo" : null),
    branches: () => Effect.sync(() => state.heads),
    pullRequests: () =>
      state.viewers === null
        ? Effect.fail(new RepoMonitorError({ message: "gh is not signed in" }))
        : Effect.succeed({ entries: [], viewers: state.viewers }),
    issues: () => Effect.sync(() => state.issues),
  });
  const store = repoMonitorStoreLayer.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const layer = Layer.effect(
    RepoMonitorService.RepoMonitorService,
    RepoMonitorService.make({
      snapshotProvider: (projectId) =>
        source.observe(projectId).pipe(Effect.map((o) => o.snapshot)),
      onActionTriggered: RepoMonitorRuntimeWiring.makeActionDispatcher(ports),
    }),
  ).pipe(
    Layer.provideMerge(Layer.succeed(RepoMonitorRuntimeWiring.RepoMonitorSnapshotSource, source)),
    Layer.provideMerge(store),
    Layer.provideMerge(PlatformNodeCrypto.layer),
  );
  return { layer, dispatched, state };
};

const pushRule = {
  projectId: PROJECT_ID,
  name: TrimmedNonEmptyString.make("Review pushes"),
  enabled: true,
  eventKinds: ["branch_push" as const],
  filter: {},
  actionKind: "launch_thread" as const,
  promptTemplate: TrimmedNonEmptyString.make("Review {{branch}} at {{commitSha}}"),
  cooldownSec: NonNegativeInt.make(0),
  maxTriggersPerHour: PositiveInt.make(20),
};

const sign = (body: string) =>
  `sha256=${NodeCrypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("RepoMonitorRuntimeWiring", () => {
  it.effect("routes each action kind to its port and refuses a send with no target", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const dispatch = RepoMonitorRuntimeWiring.makeActionDispatcher({
        notifyPm: () => Effect.sync(() => void calls.push("notify")),
        launchThread: () => Effect.sync(() => (calls.push("launch"), LAUNCHED)),
        sendToThread: (input) => Effect.sync(() => void calls.push(`send:${input.threadId}`)),
      });
      const rule: RepoMonitorRule = {
        ...pushRule,
        id: RepoMonitorRuleId.make("rule-1"),
        createdAt: "2026-11-22T00:00:00.000Z",
        updatedAt: "2026-11-22T00:00:00.000Z",
      };
      const input = (overrides: Partial<RepoMonitorRule>) => ({
        rule: { ...rule, ...overrides },
        event: RepoMonitorRuntimeWiring.parseGitHubWebhookEvent({
          projectId: PROJECT_ID,
          githubEvent: "push",
          body: JSON.stringify({ ref: "refs/heads/main", after: "sha-2" }),
          receivedAt: "2026-11-22T00:00:00.000Z",
        })!,
        dedupeKey: "dk",
        renderedPrompt: "prompt",
      });

      assert.deepStrictEqual(yield* dispatch(input({ actionKind: "notify_pm" })), {
        dispatchedThreadId: null,
      });
      assert.deepStrictEqual(yield* dispatch(input({ actionKind: "launch_thread" })), {
        dispatchedThreadId: LAUNCHED,
      });
      const target = ThreadId.make("thread-target");
      assert.deepStrictEqual(
        yield* dispatch(input({ actionKind: "send_to_thread", targetThreadId: target })),
        { dispatchedThreadId: target },
      );
      const missing = yield* Effect.flip(
        dispatch(input({ actionKind: "send_to_thread", targetThreadId: null })),
      );
      assert.include(missing.message, "names none");
      assert.deepStrictEqual(calls, ["notify", "launch", "send:thread-target"]);
    }),
  );

  it("parses the GitHub deliveries the monitor watches and ignores the rest", () => {
    const parse = (githubEvent: string, body: unknown) =>
      RepoMonitorRuntimeWiring.parseGitHubWebhookEvent({
        projectId: PROJECT_ID,
        githubEvent,
        body: JSON.stringify(body),
        receivedAt: "2026-11-22T12:00:00.000Z",
      });
    const pr = {
      number: 7,
      title: "Add feature",
      body: "Details",
      html_url: "https://github.com/o/r/pull/7",
      user: { login: "dependabot[bot]", type: "Bot" },
      labels: [{ name: "deps" }],
      head: { ref: "feat", sha: "abc" },
      base: { ref: "main" },
    };

    const push = parse("push", {
      ref: "refs/heads/feat",
      before: "000",
      after: "abc",
      head_commit: { message: "Fix bug\n\nlong text" },
      sender: { login: "alice", type: "User" },
    });
    assert.deepInclude(push, {
      kind: "branch_push",
      branch: "feat",
      commitSha: "abc",
      previousCommitSha: null,
      title: "Fix bug",
      authorLogin: "alice",
      isBot: false,
    });
    assert.deepInclude(parse("pull_request", { action: "opened", pull_request: pr }), {
      kind: "pr_opened",
      pullRequestNumber: 7,
      isBot: true,
      labels: ["deps"],
      baseBranch: "main",
    });
    assert.deepInclude(
      parse("pull_request", { action: "closed", pull_request: { ...pr, merged: true } }),
      { kind: "pr_merged", branch: "main", headBranch: "feat", commitSha: null },
    );
    assert.deepInclude(
      parse("push", { ref: "refs/heads/main", before: "aaa", after: "bbb", head_commit: null }),
      { title: "Push to main", previousCommitSha: "aaa", authorLogin: null },
    );
    assert.deepInclude(
      parse("issue_comment", {
        action: "created",
        issue: { ...pr, pull_request: {} },
        comment: {
          id: 99,
          body: "LGTM",
          html_url: "https://github.com/o/r/pull/7#c99",
          user: { login: "bob" },
          created_at: "2026-11-22T11:00:00Z",
        },
      }),
      { kind: "pr_comment", pullRequestNumber: 7, commentId: "99", issueKey: null },
    );
    assert.deepInclude(parse("issues", { action: "opened", issue: pr }), {
      kind: "issue_opened",
      issueKey: "7",
    });

    assert.isNull(parse("pull_request", { action: "closed", pull_request: pr }));
    assert.isNull(parse("push", { ref: "refs/tags/v1", after: "abc" }));
    assert.isNull(parse("push", { ref: "refs/heads/gone", after: "000", deleted: true }));
    assert.isNull(parse("star", {}));
    assert.isNull(parse("push", "not json"));
  });

  it.effect(
    "polls every ruled project, survives a forge that is down and a failing action, and never re-emits",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* Migration0109;
        yield* TestClock.adjust(Duration.hours(100));
        const service = yield* RepoMonitorService.RepoMonitorService;
        yield* service.upsertRule(pushRule);
        yield* service.upsertRule({
          ...pushRule,
          name: TrimmedNonEmptyString.make("Tell PM"),
          actionKind: "notify_pm",
        });

        assert.lengthOf(yield* RepoMonitorRuntimeWiring.runRepoMonitorPollCycle(), 0);

        harness.state.heads = [{ name: "main", headSha: "sha-2" }];
        harness.state.failLaunch = true;
        const second = yield* RepoMonitorRuntimeWiring.runRepoMonitorPollCycle();
        assert.deepStrictEqual(
          second.map((event) => [event.outcome, event.commitSha]),
          [["triggered", "sha-2"]],
        );
        assert.deepStrictEqual(
          harness.dispatched.map(({ kind, input }) => [kind, input.event.previousCommitSha]),
          [["notify_pm", "sha-1"]],
        );

        harness.state.failLaunch = false;
        assert.lengthOf(yield* RepoMonitorRuntimeWiring.runRepoMonitorPollCycle(), 0);
        assert.lengthOf(harness.dispatched, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "ingests signed webhooks, rejects unsigned ones, and skips this environment's own pushes",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* Migration0109;
        yield* TestClock.adjust(Duration.hours(100));
        const service = yield* RepoMonitorService.RepoMonitorService;
        yield* service.upsertRule({ ...pushRule, actionKind: "notify_pm" });
        harness.state.viewers = ["t3-agent"];
        yield* RepoMonitorRuntimeWiring.runRepoMonitorPollCycle();

        const deliver = (body: string, signature = sign(body), githubEvent = "push") =>
          RepoMonitorRuntimeWiring.handleRepoMonitorWebhook({
            projectId: PROJECT_ID,
            secret: SECRET,
            headers: { "x-github-event": githubEvent, "x-hub-signature-256": signature },
            body: new TextEncoder().encode(body),
          });
        const pushBy = (login: string, after: string) =>
          JSON.stringify({ ref: "refs/heads/main", before: "sha-1", after, sender: { login } });

        assert.deepStrictEqual(yield* deliver(pushBy("alice", "sha-9"), "sha256=00"), {
          status: "unauthorized",
        });
        assert.lengthOf(harness.dispatched, 0);

        const own = yield* deliver(pushBy("t3-agent", "sha-8"));
        assert.deepStrictEqual(
          own.status === "accepted" ? own.events.map((event) => event.outcome) : own.status,
          ["skipped_loop_guard"],
        );
        assert.lengthOf(harness.dispatched, 0);

        const accepted = yield* deliver(pushBy("alice", "sha-9"));
        assert.strictEqual(accepted.status, "accepted");
        assert.deepStrictEqual(
          harness.dispatched.map(({ kind, input }) => [kind, input.event.commitSha]),
          [["notify_pm", "sha-9"]],
        );

        assert.deepStrictEqual(yield* deliver(JSON.stringify({ zen: "hi" }), undefined, "ping"), {
          status: "ignored",
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "never runs on its own issues while pull requests cannot be listed, and recovers once they can",
    () => {
      const harness = makeHarness();
      const issueBy = (key: string, authorLogin: string): RepoMonitorIssueSnapshot => ({
        key,
        title: `Issue ${key}`,
        stateCategory: "open",
        authorLogin,
        labels: [],
        createdAt: "2026-11-22T00:00:00.000Z",
        updatedAt: "2026-11-22T00:00:00.000Z",
      });
      const poll = (issues: ReadonlyArray<RepoMonitorIssueSnapshot>) => {
        harness.state.issues = [...harness.state.issues, ...issues];
        return RepoMonitorRuntimeWiring.runRepoMonitorPollCycle().pipe(
          Effect.map((triggered) => triggered.map((event) => event.issueKey)),
        );
      };
      return Effect.gen(function* () {
        yield* Migration0109;
        yield* TestClock.adjust(Duration.hours(100));
        const service = yield* RepoMonitorService.RepoMonitorService;
        yield* service.upsertRule({
          ...pushRule,
          name: TrimmedNonEmptyString.make("Triage issues"),
          eventKinds: ["issue_opened"],
          actionKind: "notify_pm",
          promptTemplate: TrimmedNonEmptyString.make("Triage {{issueKey}}"),
        });

        // Cold start with the forge identity never resolved: nothing authored may run.
        assert.deepStrictEqual(yield* poll([]), []);
        assert.deepStrictEqual(yield* poll([issueBy("1", "t3-agent"), issueBy("2", "alice")]), []);

        harness.state.viewers = ["t3-agent"];
        assert.deepStrictEqual(yield* poll([issueBy("3", "t3-agent"), issueBy("4", "alice")]), [
          "4",
        ]);

        // Pull requests fail again: the identity seen last still guards issues.
        harness.state.viewers = null;
        assert.deepStrictEqual(yield* poll([issueBy("5", "t3-agent"), issueBy("6", "bob")]), ["6"]);
        assert.deepStrictEqual(
          harness.dispatched.map(({ input }) => input.event.issueKey),
          ["4", "6"],
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("skips authored webhooks until the forge identity is known", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* Migration0109;
      yield* TestClock.adjust(Duration.hours(100));
      const service = yield* RepoMonitorService.RepoMonitorService;
      yield* service.upsertRule({ ...pushRule, actionKind: "notify_pm" });
      yield* RepoMonitorRuntimeWiring.runRepoMonitorPollCycle();

      const body = JSON.stringify({
        ref: "refs/heads/main",
        before: "sha-1",
        after: "sha-7",
        sender: { login: "t3-agent" },
      });
      const own = yield* RepoMonitorRuntimeWiring.handleRepoMonitorWebhook({
        projectId: PROJECT_ID,
        secret: SECRET,
        headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
        body: new TextEncoder().encode(body),
      });
      assert.deepStrictEqual(
        own.status === "accepted" ? own.events.map((event) => event.outcome) : own.status,
        ["skipped_loop_guard"],
      );
      assert.lengthOf(harness.dispatched, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("serializes concurrent poll and webhook processing for the same project", () =>
    Effect.gen(function* () {
      const trace: string[] = [];
      const pollStarted = yield* Deferred.make<void>();
      const releasePoll = yield* Deferred.make<void>();
      const store = repoMonitorStoreLayer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      );
      const source = RepoMonitorRuntimeWiring.RepoMonitorSnapshotSource.of({
        lastSelfAccountLogins: () => Effect.succeed([]),
        observe: (projectId) =>
          Effect.gen(function* () {
            trace.push("poll:start");
            yield* Deferred.succeed(pollStarted, undefined);
            yield* Deferred.await(releasePoll);
            trace.push("poll:end");
            return {
              snapshot: {
                projectId,
                observedAt: "2026-11-22T00:00:00.000Z",
                branches: [{ name: "main", headSha: "sha-1" }],
                pullRequests: [],
                issues: [],
              },
              selfAccountLogins: [],
            };
          }),
      });
      const baseServiceLayer = Layer.effect(
        RepoMonitorService.RepoMonitorService,
        RepoMonitorService.make({
          snapshotProvider: () => Effect.die("unused"),
          onActionTriggered: () => Effect.sync(() => ({ dispatchedThreadId: null })),
        }),
      ).pipe(Layer.provideMerge(store), Layer.provideMerge(PlatformNodeCrypto.layer));
      const serviceLayer = Layer.effect(
        RepoMonitorService.RepoMonitorService,
        Effect.map(RepoMonitorService.RepoMonitorService, (service) => ({
          ...service,
          ingestWebhookEvent: (input) =>
            Effect.sync(() => {
              trace.push("webhook");
            }).pipe(Effect.flatMap(() => service.ingestWebhookEvent(input))),
        })),
      ).pipe(Layer.provideMerge(baseServiceLayer));
      const testLayer = Layer.mergeAll(
        serviceLayer,
        Layer.succeed(RepoMonitorRuntimeWiring.RepoMonitorSnapshotSource, source),
      );

      yield* Effect.gen(function* () {
        yield* Migration0109;
        yield* TestClock.adjust(Duration.hours(100));
        const repoService = yield* RepoMonitorService.RepoMonitorService;
        yield* repoService.upsertRule({ ...pushRule, actionKind: "notify_pm" });

        const pollFiber = yield* Effect.forkChild(
          RepoMonitorRuntimeWiring.runRepoMonitorPollCycle(),
        );
        yield* Deferred.await(pollStarted);

        const body = JSON.stringify({ ref: "refs/heads/main", before: "sha-1", after: "sha-2" });
        const webhookFiber = yield* Effect.forkChild(
          RepoMonitorRuntimeWiring.handleRepoMonitorWebhook({
            projectId: PROJECT_ID,
            secret: SECRET,
            headers: { "x-github-event": "push", "x-hub-signature-256": sign(body) },
            body: new TextEncoder().encode(body),
          }),
        );
        yield* Effect.yieldNow;
        assert.deepStrictEqual(trace, ["poll:start"]);

        yield* Deferred.succeed(releasePoll, undefined);
        yield* Fiber.join(pollFiber);
        yield* Fiber.join(webhookFiber);
        assert.deepStrictEqual(trace, ["poll:start", "poll:end", "webhook"]);
      }).pipe(Effect.provide(testLayer));
    }),
  );
});

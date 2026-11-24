import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadHandoffService from "./ThreadHandoffService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const sourceThreadId = ThreadId.make("thread:handoff-source");
const targetThreadId = ThreadId.make("thread:handoff-target");
const projectId = ProjectId.make("project:handoff");
const targetModel = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
} satisfies ModelSelection;

// Only the fields the service reads.
const shell = {
  id: sourceThreadId,
  projectId,
  title: "Fix login",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "fix/login",
  worktreePath: "/repo/.worktrees/login",
} as OrchestrationV2ThreadShell;

const transcript = (items: ReadonlyArray<Partial<OrchestrationV2TurnItem>>) =>
  ({
    threadId: sourceThreadId,
    title: shell.title,
    items: items.map((item) => ({ item })),
  }) as unknown as OrchestrationV2ThreadTranscript;

const conversation = [
  { type: "user_message", text: "ログインを直して" },
  { type: "command_execution", input: "vp test run", output: "1 failed", exitCode: 1 },
  { type: "file_change", fileName: "src/login.ts", additions: 3, deletions: 1 },
  { type: "reasoning", text: "private chain of thought" },
  { type: "assistant_message", text: "Fixed `login()`." },
] as ReadonlyArray<Partial<OrchestrationV2TurnItem>>;

const run = (options: {
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly items?: ReadonlyArray<Partial<OrchestrationV2TurnItem>>;
  readonly launchFails?: boolean;
  readonly maxBytes?: number;
}) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const layer = ThreadHandoffService.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(options.shell),
          getThreadTranscript: () => Effect.succeed(transcript(options.items ?? conversation)),
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launches, (all) => [...all, input]).pipe(
              Effect.andThen(
                options.launchFails
                  ? Effect.fail(
                      new ThreadLaunch.ThreadLaunchError({
                        operation: "create-thread",
                        commandId: input.commandId,
                        projectId: input.projectId,
                        cause: "disk full",
                      }),
                    )
                  : Effect.succeed({
                      threadId: targetThreadId,
                      projection: {} as OrchestrationV2ThreadProjection,
                      resumed: false,
                    }),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
      ),
      Layer.provide(Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({})),
    );
    const result = yield* ThreadHandoffService.ThreadHandoffService.pipe(
      Effect.flatMap((service) =>
        service.handoff({
          commandId: CommandId.make("command:handoff"),
          threadId: sourceThreadId,
          modelSelection: targetModel,
          ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
          createdBy: "user",
          creationSource: "web",
        }),
      ),
      Effect.result,
      Effect.provide(layer),
    );
    return { result, launches: yield* Ref.get(launches) };
  });

it.effect("launches the target model with the raw transcript in the source workspace", () =>
  Effect.gen(function* () {
    const { result, launches } = yield* run({ shell });

    assert.strictEqual(result._tag, "Success");
    if (result._tag !== "Success") return;
    assert.deepStrictEqual(
      { ...result.success, bytes: 0 },
      {
        sourceThreadId,
        threadId: targetThreadId,
        mode: "raw",
        bytes: 0,
        turnCount: 1,
        omittedTurnCount: 0,
        truncatedToolOutputCount: 0,
      },
    );
    const launch = launches[0]!;
    assert.strictEqual(launches.length, 1);
    assert.deepStrictEqual(launch.modelSelection, targetModel);
    assert.strictEqual(launch.projectId, projectId);
    assert.strictEqual(launch.titleRenamed, true);
    assert.deepStrictEqual(launch.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: "/repo/.worktrees/login",
      branch: "fix/login",
    });
    const text = launch.initialMessage!.text;
    assert.include(text, "**User:**\nログインを直して");
    assert.include(text, "**Assistant:**\nFixed `login()`.");
    assert.include(text, "1 failed");
    assert.include(text, "- Changed files: src/login.ts");
    assert.include(text, "- Source model: codex / gpt-5.4");
    assert.notInclude(text, "private chain of thought");
  }),
);

it.effect(
  "preserves structured context and marks user and assistant attachments in the transcript",
  () =>
    Effect.gen(function* () {
      const context = {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            contextId: ComposerContextId.make("context-login"),
            kind: "custom-diagnostic",
            label: "Login failure",
            payload: { command: "vp test run", output: "認証 failed\nline 2", exitCode: 1 },
          },
        ],
      };
      const { result, launches } = yield* run({
        shell,
        items: [
          {
            type: "user_message",
            text: "Inspect this failure",
            context,
            attachments: [
              {
                type: "image",
                id: "login-image",
                name: "login.png",
                mimeType: "image/png",
                sizeBytes: 42,
              },
              {
                type: "file",
                id: "login-log",
                name: "login.log",
                mimeType: "text/plain",
                sizeBytes: 84,
              },
            ],
          },
          {
            type: "assistant_message",
            text: "See the report",
            attachments: [
              {
                type: "file",
                id: "report",
                name: "report.txt",
                mimeType: "text/plain",
                sizeBytes: 21,
              },
            ],
          },
        ],
      });

      assert.strictEqual(result._tag, "Success");
      assert.strictEqual(launches.length, 1);
      const text = launches[0]!.initialMessage!.text;
      assert.include(text, "Inspect this failure");
      assert.include(text, JSON.stringify(context, null, 2));
      assert.include(text, "[Attachment: login.png (image/png, 42 bytes, id: login-image)]");
      assert.include(text, "[Attachment: login.log (text/plain, 84 bytes, id: login-log)]");
      assert.include(text, "[Attachment: report.txt (text/plain, 21 bytes, id: report)]");
    }),
);

it.effect("fails with a typed error and launches nothing when the source thread is missing", () =>
  Effect.gen(function* () {
    const { result, launches } = yield* run({ shell: null });

    assert.strictEqual(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    assert.strictEqual(result.failure._tag, "ThreadHandoffSourceNotFoundError");
    assert.strictEqual(launches.length, 0);
  }),
);

it.effect("refuses an empty source thread instead of launching a header-only handoff", () =>
  Effect.gen(function* () {
    const { result, launches } = yield* run({ shell, items: [] });

    assert.strictEqual(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    assert.deepInclude(result.failure, { _tag: "ThreadHandoffError", operation: "build-context" });
    assert.strictEqual(launches.length, 0);
  }),
);

it.effect("reports a failed target launch as a typed handoff error", () =>
  Effect.gen(function* () {
    const { result } = yield* run({ shell, launchFails: true });

    assert.strictEqual(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    assert.deepInclude(result.failure, { _tag: "ThreadHandoffError", operation: "launch" });
  }),
);

it.effect("refuses, without launching, when the newest turn alone exceeds the budget", () =>
  Effect.gen(function* () {
    const { result, launches } = yield* run({ shell, maxBytes: 200 });

    assert.strictEqual(result._tag, "Failure");
    if (result._tag !== "Failure") return;
    assert.deepInclude(result.failure, { _tag: "ThreadHandoffError", operation: "build-context" });
    assert.strictEqual(launches.length, 0);
  }),
);

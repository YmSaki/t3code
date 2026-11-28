import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import * as CodexProtocol from "../protocol.ts";
import {
  appendStderrTail,
  makeTerminationError,
  stderrExcerpt,
  makeInMemoryStdio,
  makeStderrTail,
  makeChildStdio,
  Platform,
} from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it.effect("retains exit diagnostics when stderr stays open after stdout ends", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const captured = yield* Deferred.make<void>();
      const stderr = Stream.make(new TextEncoder().encode("Error: invalid config\n")).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(captured, undefined)).pipe(Stream.drain)),
        Stream.concat(Stream.never),
      );
      const tail = yield* makeStderrTail(stderr);
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio: makeChildStdio({ stdout: stdio.stdin, stdin: stdio.stdout() }, tail.awaitDrained),
        terminationError: makeTerminationError(
          {
            pid: ChildProcessSpawner.ProcessId(55),
            exitCode: Deferred.await(exited),
          },
          tail.read,
        ),
      });
      const pending = yield* transport.request("thread/read", {}).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected the pending request to fail"),
        }),
        Effect.forkScoped,
      );
      yield* Queue.take(output);
      yield* Deferred.await(captured);
      yield* Queue.end(input);
      yield* TestClock.adjust("100 millis");
      yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust("250 millis");
      const error = yield* Fiber.join(pending);
      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: Error: invalid config",
      );
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(52),
          exitCode: Effect.fail(cause),
        },
        Effect.succeed(""),
      );

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );

  it.effect("names the stderr error line when the process exits", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(53),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        Effect.succeed("Error: Missing optional dependency @openai/codex-darwin-arm64.\n"),
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.stderr, "Error: Missing optional dependency @openai/codex-darwin-arm64.");
      assert.equal(
        error.message,
        "Codex App Server process exited with code 1: Error: Missing optional dependency @openai/codex-darwin-arm64.",
      );
    }),
  );

  it.effect("keeps the bare exit message when stderr is empty", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError(
        {
          pid: ChildProcessSpawner.ProcessId(54),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        },
        Effect.succeed(" \n\n"),
      );

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.isUndefined(error.stderr);
      assert.equal(error.message, "Codex App Server process exited with code 1");
    }),
  );
});

describe("Codex App Server stderr decoding", () => {
  // "指定されたパスが見つかりません。" in CP932, as cmd.exe prints it on Japanese Windows.
  const cp932PathNotFound = Uint8Array.from([
    142, 119, 146, 232, 130, 179, 130, 234, 130, 189, 131, 112, 131, 88, 130, 170, 140, 169, 130,
    194, 130, 169, 130, 232, 130, 220, 130, 185, 130, 241, 129, 66,
  ]);
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const readTail = (chunks: ReadonlyArray<Uint8Array>, platform: NodeJS.Platform) =>
    Effect.gen(function* () {
      const tail = yield* makeStderrTail(Stream.fromIterable(chunks));
      yield* tail.awaitDrained;
      return yield* tail.read;
    }).pipe(Effect.provideService(Platform, platform));

  it.effect("decodes CP932 stderr on Windows", () =>
    Effect.gen(function* () {
      const crlf = Uint8Array.from([13, 10]);
      const tail = yield* readTail(
        [cp932PathNotFound.subarray(0, 5), cp932PathNotFound.subarray(5), crlf],
        "win32",
      );
      assert.equal(tail, "指定されたパスが見つかりません。\r\n");
    }),
  );

  it.effect("decodes UTF-8 and CP932 lines independently on Windows", () =>
    Effect.gen(function* () {
      const tail = yield* readTail(
        [utf8("Error: C:\\ユーザー\\設定.toml\n"), cp932PathNotFound],
        "win32",
      );
      assert.equal(tail, "Error: C:\\ユーザー\\設定.toml\n指定されたパスが見つかりません。");
    }),
  );

  it.effect.each(["win32", "linux"] as const)(
    "keeps UTF-8 characters split across chunks on %s",
    (platform) =>
      Effect.gen(function* () {
        const bytes = utf8("Error: /home/ユーザー/設定.toml が見つかりません\n");
        const tail = yield* readTail(
          Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1)),
          platform,
        );
        assert.equal(tail, "Error: /home/ユーザー/設定.toml が見つかりません\n");
      }),
  );

  it.effect("keeps long UTF-8 lines valid after trimming the pending buffer on Windows", () =>
    Effect.gen(function* () {
      const bytes = utf8(`${"あ".repeat(11_002)}\n`);
      const singleChunk = yield* readTail([bytes], "win32");
      const splitMidChar = yield* readTail(
        [bytes.subarray(0, 33_004), bytes.subarray(33_004)],
        "win32",
      );
      assert.equal(splitMidChar, singleChunk);
      assert.isTrue(splitMidChar.endsWith("あああああ\n"));
      assert.isFalse(splitMidChar.includes("\uFFFD"));
    }),
  );

  it.effect("keeps long CP932 lines invariant across chunk boundaries when ASCII follows", () =>
    Effect.gen(function* () {
      const prefix = Uint8Array.from([0x82, 0xa0]);
      const mid = new Uint8Array(32_768).fill(0x61);
      const suffix = Uint8Array.from([0xc2, 0xa9, 0x0a]);
      const combined = new Uint8Array(prefix.length + mid.length + suffix.length);
      combined.set(prefix, 0);
      combined.set(mid, prefix.length);
      combined.set(suffix, prefix.length + mid.length);
      const singleChunk = yield* readTail([combined], "win32");
      const splitBeforeLf = yield* readTail(
        [combined.subarray(0, combined.length - 1), combined.subarray(combined.length - 1)],
        "win32",
      );
      assert.equal(splitBeforeLf, singleChunk);
      assert.isTrue(splitBeforeLf.endsWith("aaaﾂｩ\n"));
    }),
  );

  it.effect("keeps long CP932 lines aligned across chunk boundaries on Windows", () =>
    Effect.gen(function* () {
      const longCp932 = new Uint8Array(40_001);
      longCp932[0] = 0x61; // odd-offset prefix 'a' + 20,000 CP932 'リ' (0x83, 0x8a)
      for (let i = 1; i < longCp932.length; i += 2) {
        longCp932[i] = 0x83;
        longCp932[i + 1] = 0x8a;
      }
      const lf = Uint8Array.from([10]);
      const combined = new Uint8Array(longCp932.length + 1);
      combined.set(longCp932);
      combined.set(lf, longCp932.length);
      const singleChunk = yield* readTail([combined], "win32");
      const splitChunks = yield* readTail([longCp932, lf], "win32");
      assert.equal(splitChunks, singleChunk);
      assert.isTrue(splitChunks.endsWith("リリリ\n"));
    }),
  );

  it.effect("keeps CP932 fallback restricted to Windows", () =>
    Effect.gen(function* () {
      const tail = yield* readTail([cp932PathNotFound], "linux");
      assert.equal(tail, new TextDecoder("utf-8", { ignoreBOM: true }).decode(cp932PathNotFound));
    }),
  );

  it.effect("retains interior U+FEFF characters across lines", () =>
    Effect.gen(function* () {
      const tail = yield* readTail([utf8("x\n\uFEFFy")], "linux");
      assert.equal(tail, "x\n\uFEFFy");
    }),
  );
});

describe("Codex App Server stderr excerpt", () => {
  it.each([
    {
      name: "Node launcher missing its platform package",
      stderr: [
        "file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:107",
        "  throw new Error(",
        "        ^",
        "",
        "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
        "    at findCodexExecutable (file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:107:9)",
        "    at file:///usr/local/lib/node_modules/@openai/codex/bin/codex.js:112:20",
        "",
        "Node.js v26.8.2",
        "",
      ].join("\n"),
      excerpt:
        "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest",
    },
    {
      name: "Node error with a code",
      stderr:
        "node:internal/modules/esm/resolve:873\n  throw new ERR_MODULE_NOT_FOUND(\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'\n    at packageResolve (node:internal/modules/esm/resolve:873:9)\n",
      excerpt: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'",
    },
    {
      name: "Rust CLI error",
      stderr: "error: unexpected argument 'app-server' found\n\nUsage: codex [OPTIONS]\n",
      excerpt: "error: unexpected argument 'app-server' found",
    },
    {
      name: "uppercase error label",
      stderr: "ERROR: Missing dependency\nUsage: codex [OPTIONS]\n",
      excerpt: "ERROR: Missing dependency",
    },
    {
      name: "unlabelled message",
      stderr: "WARNING: proceeding without PATH aliases\nMissing OpenAI API key.\n",
      excerpt: "Missing OpenAI API key.",
    },
    {
      name: "launcher exit summary after a DNS failure",
      stderr: [
        "Starting provider",
        'проверить токен LLM: Get "https://llm-gateway.example/api/models": dial tcp: lookup llm-gateway.example: no such host',
        "не удалось отправить метрики на сервер: no such host",
        "Ошибка: ошибка запуска плагина: exit status 1",
      ].join("\n"),
      excerpt:
        'проверить токен LLM: Get "https://llm-gateway.example/api/models": dial tcp: lookup llm-gateway.example: no such host | не удалось отправить метрики на сервер: no such host | Ошибка: ошибка запуска плагина: exit status 1',
    },
    {
      name: "labelled launcher exit summary after an authentication failure",
      stderr: [
        'oauth2: "invalid_request" "Errors.OIDCSession.RefreshTokenInvalid"',
        "Error: provider launcher exited with code 1.",
      ].join("\n"),
      excerpt:
        'oauth2: "invalid_request" "Errors.OIDCSession.RefreshTokenInvalid" | Error: provider launcher exited with code 1.',
    },
    {
      name: "final launcher summary takes precedence over an earlier error label",
      stderr: [
        "Error: starting provider",
        "lookup failed: no such host",
        "Ошибка: exit status 1",
      ].join("\n"),
      excerpt: "Error: starting provider | lookup failed: no such host | Ошибка: exit status 1",
    },
    {
      name: "launcher summary alone",
      stderr: "Error: command failed with exit code 1\n",
      excerpt: "Error: command failed with exit code 1",
    },
    {
      name: "launcher diagnostics remain bounded",
      stderr: `${"x".repeat(1_000)}\noauth2: invalid_request\nError: launcher exited with code 1\n`,
      excerpt: `…${`${"x".repeat(1_000)} | oauth2: invalid_request | Error: launcher exited with code 1`.slice(-511)}`,
    },
    {
      name: "ANSI color, carriage returns and repeated whitespace",
      stderr: "\u001b[31m  Error:\t  config.toml   is invalid \u001b[0m\r\n",
      excerpt: "Error: config.toml is invalid",
    },
    {
      name: "C1 terminal controls",
      stderr: "\u009b31mError: invalid config\u009b0m\nUsage: codex [OPTIONS]\n",
      excerpt: "Error: invalid config",
    },
    {
      name: "oversized line",
      stderr: `Error: ${"x".repeat(1_000)}`,
      excerpt: `Error: ${"x".repeat(504)}…`,
    },
  ])("$name", ({ stderr, excerpt }) => {
    assert.equal(stderrExcerpt(stderr), excerpt);
    assert.isAtMost(excerpt.length, 512);
  });

  it("returns nothing for blank stderr", () => {
    assert.isUndefined(stderrExcerpt("\n \t\r\n\u001b[0m\n"));
  });

  it("keeps only the newest stderr", () => {
    const tail = appendStderrTail("a".repeat(8_000), `${"b".repeat(400)}\nError: last`);

    assert.equal(tail.length, 8_192);
    assert.isTrue(tail.endsWith("Error: last"));
    assert.equal(stderrExcerpt(tail), "Error: last");
  });
});

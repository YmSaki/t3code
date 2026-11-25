import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (
  handle: Pick<ChildProcessSpawner.ChildProcessHandle, "stdin" | "stdout">,
  stderrDrained: Effect.Effect<void>,
) =>
  Stdio.make({
    args: Effect.succeed([]),
    // Finish stderr separately from the protocol's exit-status deadline.
    stdin: handle.stdout.pipe(Stream.onEnd(stderrDrained)),
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

const STDERR_TAIL_MAX_CHARS = 8_192;
const STDERR_EXCERPT_MAX_CHARS = 512;
// `Error: …`, `TypeError: …`, `Error [ERR_MODULE_NOT_FOUND]: …`, `error: …`, `ERROR: …`, `fatal: …`
const ERROR_LINE_PATTERN = /^(?:[a-z]*error|fatal)(?: ?\[[^\]]+\])?:\s*\S/i;
const EXIT_SUMMARY_PATTERN = /\b(?:exit status|exit code|exited with code)\s+\d+\.?$/i;

export const appendStderrTail = (current: string, chunk: string): string => {
  const next = `${current}${chunk}`;
  return next.length <= STDERR_TAIL_MAX_CHARS ? next : next.slice(-STDERR_TAIL_MAX_CHARS);
};

// Node launchers print the actionable error between a source excerpt and stack frames.
export const stderrExcerpt = (tail: string): string | undefined => {
  const lines = NodeUtil.stripVTControlCharacters(tail)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  const errorIndex = lines.findLastIndex((candidate) => ERROR_LINE_PATTERN.test(candidate));
  const lineIndex =
    errorIndex === -1 || EXIT_SUMMARY_PATTERN.test(lines.at(-1) ?? "")
      ? lines.length - 1
      : errorIndex;
  const line = lines[lineIndex];
  if (line === undefined) {
    return undefined;
  }
  // Wrappers can print the actual failure before their generic exit-status summary.
  const excerpt = EXIT_SUMMARY_PATTERN.test(line)
    ? lines.slice(Math.max(0, lineIndex - 2), lineIndex + 1).join(" | ")
    : line;
  if (excerpt.length <= STDERR_EXCERPT_MAX_CHARS) {
    return excerpt;
  }
  return excerpt !== line
    ? `…${excerpt.slice(-(STDERR_EXCERPT_MAX_CHARS - 1))}`
    : `${excerpt.slice(0, STDERR_EXCERPT_MAX_CHARS - 1)}…`;
};

// Japanese Windows tools write stderr in the ANSI code page (CP932), not UTF-8.
const decodeStderrLine = (bytes: Uint8Array, platform: NodeJS.Platform): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return new TextDecoder(platform === "win32" ? "shift_jis" : "utf-8", {
      ignoreBOM: true,
    }).decode(bytes);
  }
};

const STDERR_PENDING_MAX_BYTES = STDERR_TAIL_MAX_CHARS * 4;

const trimPendingLineTail = (
  bytes: Uint8Array<ArrayBuffer>,
  start: number,
): Uint8Array<ArrayBuffer> => {
  const minStart = bytes.length - STDERR_PENDING_MAX_BYTES;
  if (minStart <= start) {
    return bytes.slice(start);
  }
  let trimStart = minStart;
  // Avoid landing in the middle of a multi-byte UTF-8 sequence, which would force CP932 fallback.
  for (let i = 0; i < 3 && trimStart < bytes.length && (bytes[trimStart]! & 0xc0) === 0x80; i++) {
    trimStart += 1;
  }
  return bytes.slice(trimStart);
};

export const makeStderrTail = Effect.fn("makeStderrTail")(function* (
  stderr: ChildProcessSpawner.ChildProcessHandle["stderr"],
) {
  const platform = yield* HostProcess.Platform;
  // Decode whole lines so multi-byte characters split across chunks stay intact.
  const tail = yield* Ref.make({ text: "", pending: new Uint8Array(0) });
  const drain = yield* stderr.pipe(
    Stream.runForEach((chunk) =>
      Ref.update(tail, ({ text, pending }) => {
        const bytes = new Uint8Array(pending.length + chunk.length);
        bytes.set(pending);
        bytes.set(chunk, pending.length);
        let start = 0;
        for (let end = bytes.indexOf(0x0a); end !== -1; end = bytes.indexOf(0x0a, start)) {
          text = appendStderrTail(text, decodeStderrLine(bytes.subarray(start, end + 1), platform));
          start = end + 1;
        }
        return {
          text,
          pending: trimPendingLineTail(bytes, start),
        };
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  return {
    read: Ref.get(tail).pipe(
      Effect.map(({ text, pending }) =>
        appendStderrTail(text, decodeStderrLine(pending, platform)),
      ),
    ),
    awaitDrained: Fiber.join(drain).pipe(Effect.timeout("250 millis"), Effect.ignore),
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
  stderrTail: Effect.Effect<string>,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.matchEffect(handle.exitCode, {
    onFailure: (cause) =>
      Effect.succeed(
        new CodexError.CodexAppServerTransportError({
          operation: "read-process-exit-status",
          pid: handle.pid,
          cause,
        }),
      ),
    onSuccess: (code) =>
      Effect.map(stderrTail, (tail) => {
        const stderr = stderrExcerpt(tail);
        return new CodexError.CodexAppServerProcessExitedError({
          code,
          pid: handle.pid,
          ...(stderr ? { stderr } : {}),
        });
      }),
  });

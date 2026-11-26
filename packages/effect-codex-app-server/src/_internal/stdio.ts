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

interface StderrLineState {
  readonly utf8Decoder: NodeUtil.TextDecoder;
  readonly fallbackDecoder: NodeUtil.TextDecoder;
  utf8Valid: boolean;
  utf8Tail: string;
  fallbackTail: string;
}

const makeStderrLineState = (platform: NodeJS.Platform): StderrLineState => ({
  utf8Decoder: new NodeUtil.TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
  fallbackDecoder: new NodeUtil.TextDecoder(platform === "win32" ? "shift_jis" : "utf-8", {
    ignoreBOM: true,
  }),
  utf8Valid: true,
  utf8Tail: "",
  fallbackTail: "",
});

const feedStderrLine = (line: StderrLineState, segment: Uint8Array, stream: boolean): void => {
  if (line.utf8Valid) {
    try {
      const decoded = line.utf8Decoder.decode(segment, { stream });
      if (decoded.length > 0) {
        line.utf8Tail = appendStderrTail(line.utf8Tail, decoded);
      }
    } catch {
      line.utf8Valid = false;
    }
  }
  const fallbackDecoded = line.fallbackDecoder.decode(segment, { stream });
  if (fallbackDecoded.length > 0) {
    line.fallbackTail = appendStderrTail(line.fallbackTail, fallbackDecoded);
  }
};

export const makeStderrTail = Effect.fn("makeStderrTail")(function* (
  stderr: ChildProcessSpawner.ChildProcessHandle["stderr"],
) {
  const platform = yield* HostProcess.Platform;
  // Stream each line through dual decoders so output is independent of chunk boundaries.
  const tail = yield* Ref.make({ text: "", line: makeStderrLineState(platform) });
  const drain = yield* stderr.pipe(
    Stream.runForEach((chunk) =>
      Ref.update(tail, ({ text, line }) => {
        let start = 0;
        let currentLine = line;
        for (let end = chunk.indexOf(0x0a); end !== -1; end = chunk.indexOf(0x0a, start)) {
          feedStderrLine(currentLine, chunk.subarray(start, end + 1), false);
          text = appendStderrTail(
            text,
            currentLine.utf8Valid ? currentLine.utf8Tail : currentLine.fallbackTail,
          );
          currentLine = makeStderrLineState(platform);
          start = end + 1;
        }
        if (start < chunk.length) {
          feedStderrLine(currentLine, chunk.subarray(start), true);
        }
        return { text, line: currentLine };
      }),
    ),
    Effect.andThen(
      Ref.update(tail, ({ text, line }) => {
        feedStderrLine(line, new Uint8Array(0), false);
        return {
          text: appendStderrTail(text, line.utf8Valid ? line.utf8Tail : line.fallbackTail),
          line: makeStderrLineState(platform),
        };
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  return {
    read: Ref.get(tail).pipe(
      Effect.map(({ text, line }) =>
        appendStderrTail(text, line.utf8Valid ? line.utf8Tail : line.fallbackTail),
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

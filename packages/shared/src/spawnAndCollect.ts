import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "./collectStreamText.ts";
import * as HostProcess from "./HostProcess.ts";

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

export const isWindowsCommandNotFound = Effect.fn("isWindowsCommandNotFound")(function* (
  code: number | null,
  stderr: string,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32") return false;
  if (code === 9009) return true;
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(stderr));
});

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ProviderCommandNotFoundError extends Schema.TaggedError<ProviderCommandNotFoundError>()(
  "ProviderCommandNotFoundError",
  {
    binaryPath: Schema.String,
    exitCode: Schema.Number,
    stdoutLength: Schema.Number,
    stderrLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider command ${this.binaryPath} was not found (exit code ${this.exitCode}).`;
  }
}

export class ProviderProbeOutputLimitError extends Schema.TaggedError<
  ProviderProbeOutputLimitError,
  { readonly brand: unique symbol }
>()("ProviderProbeOutputLimitError", {
  stream: Schema.Literals(["stdout", "stderr"]),
  maxBytes: Schema.Number,
}) {
  override get message(): string {
    return `Provider status check produced too much ${this.stream} (limit ${this.maxBytes} bytes). Check the configured executable or wrapper in this environment's terminal.`;
  }
}

// A timed-out probe interrupts the child with SIGTERM and then waits for it to exit,
// so a CLI that ignores SIGTERM would hold the caller's timeout open without this.
const PROBE_FORCE_KILL_AFTER = "1 second";
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

function withProbeForceKill(command: ChildProcess.Command): ChildProcess.Command {
  if (!ChildProcess.isStandardCommand(command) || command.options.forceKillAfter !== undefined) {
    return command;
  }
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    forceKillAfter: PROBE_FORCE_KILL_AFTER,
  });
}

export const spawnAndCollect = Effect.fn("snapshotProbe.spawnAndCollect")(function* (
  binaryPath: string,
  command: ChildProcess.Command,
  options?: { readonly maxStdoutBytes: number },
) {
  const maxStdoutBytes = options?.maxStdoutBytes ?? MAX_PROBE_OUTPUT_BYTES;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(withProbeForceKill(command));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectUint8StreamText({ stream: child.stdout, maxBytes: maxStdoutBytes }),
      collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_PROBE_OUTPUT_BYTES }),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  const oversized = stdout.truncated ? "stdout" : stderr.truncated ? "stderr" : undefined;
  if (oversized !== undefined) {
    return yield* new ProviderProbeOutputLimitError({
      stream: oversized,
      maxBytes: oversized === "stdout" ? maxStdoutBytes : MAX_PROBE_OUTPUT_BYTES,
    });
  }
  const result: CommandResult = { stdout: stdout.text, stderr: stderr.text, code: exitCode };
  if (yield* isWindowsCommandNotFound(exitCode, stderr.text)) {
    return yield* new ProviderCommandNotFoundError({
      binaryPath,
      exitCode,
      stdoutLength: stdout.text.length,
      stderrLength: stderr.text.length,
    });
  }
  return result;
}, Effect.scoped);

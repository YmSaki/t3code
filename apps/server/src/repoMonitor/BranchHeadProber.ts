import { RepoMonitorError } from "@t3tools/contracts";
import type { RepoMonitorBranchSnapshot } from "@t3tools/shared/repoMonitorEval.core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const LS_REMOTE_HEAD_LINE = /^([0-9a-fA-F]{40,64})\s+refs\/heads\/(.+)$/;

export function parseGitLsRemoteHeads(stdout: string): ReadonlyArray<RepoMonitorBranchSnapshot> {
  const results: RepoMonitorBranchSnapshot[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.endsWith("^{}")) continue;
    const match = LS_REMOTE_HEAD_LINE.exec(line);
    if (!match) continue;
    const headSha = match[1]!.toLowerCase();
    const name = match[2]!.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    results.push({ name, headSha });
  }

  return results;
}

export function parseGitLsRemoteHeadMap(stdout: string): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const entry of parseGitLsRemoteHeads(stdout)) {
    map[entry.name] = entry.headSha;
  }
  return map;
}

export interface BranchHeadCommandInput {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs?: number | undefined;
}

export interface BranchHeadCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type BranchHeadCommandRunner = (
  input: BranchHeadCommandInput,
) => Effect.Effect<BranchHeadCommandOutput, RepoMonitorError>;

export interface ProbeBranchHeadsInput {
  readonly cwd: string;
  readonly remote?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export class BranchHeadProber extends Context.Service<
  BranchHeadProber,
  {
    readonly probeHeads: (
      input: ProbeBranchHeadsInput,
    ) => Effect.Effect<ReadonlyArray<RepoMonitorBranchSnapshot>, RepoMonitorError>;
  }
>()("t3/repoMonitor/BranchHeadProber") {}

/** @public */
export function makeFromCommandRunner(
  runCommand: BranchHeadCommandRunner,
): BranchHeadProber["Service"] {
  return BranchHeadProber.of({
    probeHeads: Effect.fn("BranchHeadProber.probeHeads")(function* (input) {
      const remote = input.remote ?? "origin";
      const output = yield* runCommand({
        cwd: input.cwd,
        args: ["ls-remote", "--heads", remote],
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      });

      if (output.exitCode !== 0) {
        return yield* new RepoMonitorError({
          message: `git ls-remote --heads ${remote} exited with code ${output.exitCode}: ${output.stderr.trim()}`,
        });
      }

      return parseGitLsRemoteHeads(output.stdout);
    }),
  });
}

export function layerFromCommandRunner(
  runCommand: BranchHeadCommandRunner,
): Layer.Layer<BranchHeadProber> {
  return Layer.succeed(BranchHeadProber, makeFromCommandRunner(runCommand));
}

/** @public */
export const layer: Layer.Layer<BranchHeadProber, never, GitVcsDriver.GitVcsDriver> = Layer.effect(
  BranchHeadProber,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return makeFromCommandRunner((input) =>
      git
        .execute({
          operation: "BranchHeadProber.probeHeads",
          cwd: input.cwd,
          args: input.args,
          allowNonZeroExit: true,
          timeoutMs: input.timeoutMs ?? 15_000,
        })
        .pipe(
          Effect.map((result) => ({
            exitCode: Number(result.exitCode),
            stdout: result.stdout,
            stderr: result.stderr,
          })),
          Effect.mapError(
            (cause) =>
              new RepoMonitorError({
                message: "Failed to execute git ls-remote --heads",
                cause,
              }),
          ),
        ),
    );
  }),
);

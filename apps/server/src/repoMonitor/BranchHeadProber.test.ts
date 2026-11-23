import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  BranchHeadProber,
  layerFromCommandRunner,
  parseGitLsRemoteHeadMap,
  parseGitLsRemoteHeads,
} from "./BranchHeadProber.ts";

const SAMPLE_LS_REMOTE_STDOUT = [
  "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\trefs/heads/main",
  "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5\trefs/heads/feature/repo-monitor",
  "1111111111111111111111111111111111111111\trefs/tags/v1.0.0",
  "2222222222222222222222222222222222222222\trefs/heads/peeled^{}",
  "",
].join("\n");

describe("parseGitLsRemoteHeads", () => {
  it("parses branch heads and ignores tags, peeled refs, and blank lines", () => {
    const parsed = parseGitLsRemoteHeads(SAMPLE_LS_REMOTE_STDOUT);
    assert.deepStrictEqual(parsed, [
      {
        name: "main",
        headSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      },
      {
        name: "feature/repo-monitor",
        headSha: "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
      },
    ]);

    assert.deepStrictEqual(parseGitLsRemoteHeadMap(SAMPLE_LS_REMOTE_STDOUT), {
      main: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "feature/repo-monitor": "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
    });
  });
});

describe("BranchHeadProber", () => {
  it.effect("invokes git ls-remote --heads through the injected command runner", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly cwd: string; readonly args: ReadonlyArray<string> }> = [];
      const proberLayer = layerFromCommandRunner((input) => {
        calls.push({ cwd: input.cwd, args: input.args });
        return Effect.succeed({
          exitCode: 0,
          stdout: SAMPLE_LS_REMOTE_STDOUT,
          stderr: "",
        });
      });

      const branches = yield* Effect.gen(function* () {
        const prober = yield* BranchHeadProber;
        return yield* prober.probeHeads({ cwd: "/workspace/repo", remote: "upstream" });
      }).pipe(Effect.provide(proberLayer));

      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], {
        cwd: "/workspace/repo",
        args: ["ls-remote", "--heads", "upstream"],
      });
      assert.strictEqual(branches.length, 2);
    }),
  );

  it.effect("fails with RepoMonitorError when git ls-remote returns non-zero exit code", () =>
    Effect.gen(function* () {
      const proberLayer = layerFromCommandRunner(() =>
        Effect.succeed({
          exitCode: 128,
          stdout: "",
          stderr: "fatal: 'origin' does not appear to be a git repository",
        }),
      );

      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const prober = yield* BranchHeadProber;
          return yield* prober.probeHeads({ cwd: "/workspace/repo" });
        }).pipe(Effect.provide(proberLayer)),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "exited with code 128");
    }),
  );
});

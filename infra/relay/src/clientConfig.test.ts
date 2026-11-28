// @effect-diagnostics anyUnknownInErrorContext:off - ScratchStack.deploy is typed with `any` in its error channel by Alchemy.
import { inMemoryState } from "alchemy/State";
import * as Test from "@alchemy.run/test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { PublishClientConfig, reconcileEnvFile, tokenDigest } from "./clientConfig.ts";

describe("reconcileEnvFile", () => {
  it("replaces stale values and keeps unrelated lines", () => {
    const existing = "KEEP=yes\nA=old\n# comment\n";
    expect(reconcileEnvFile(existing, { A: "new", B: "2" })).toBe(
      "KEEP=yes\nA=new\n# comment\nB=2\n",
    );
  });

  it("appends a newline before adding to a file without one", () => {
    expect(reconcileEnvFile("A=1", { B: "2" })).toBe("A=1\nB=2\n");
  });

  it("collapses duplicate assignments to one, since parseEnv lets the last win", () => {
    expect(reconcileEnvFile("A=old\nKEEP=1\nA=older\n", { A: "new" })).toBe("A=new\nKEEP=1\n");
  });

  it("recognises every assignment form parseEnv accepts", () => {
    expect(reconcileEnvFile("A=old\n  export A = stale\nexport  A=older\n", { A: "new" })).toBe(
      "A=new\n",
    );
  });

  it("replaces a quoted multi-line value whole", () => {
    expect(reconcileEnvFile('A="one\ntwo"\nKEEP=1\n', { A: "new" })).toBe("A=new\nKEEP=1\n");
    expect(reconcileEnvFile("A='x'\nKEEP=1\n", { A: "new" })).toBe("A=new\nKEEP=1\n");
    expect(
      reconcileEnvFile(
        '# earlier "quote"\nA="first\nvalue"\nKEEP=1\nA=\'second\nvalue\'\nB=`third\nvalue`',
        { A: "new", B: "updated" },
      ),
    ).toBe('# earlier "quote"\nA=new\nKEEP=1\nB=updated\n');
  });

  it("keeps later lines when a quoted value never closes", () => {
    expect(reconcileEnvFile('A="one\nKEEP=1\n', { A: "new" })).toBe("A=new\nKEEP=1\n");
    expect(
      reconcileEnvFile("A=\"one\nKEEP='two'\nB=`three\nKEEP=2", { A: "new", B: "updated" }),
    ).toBe("A=new\nKEEP='two'\nB=updated\nKEEP=2\n");
  });

  it("leaves a commented-out assignment alone", () => {
    expect(reconcileEnvFile("#A=old\n", { A: "new" })).toBe("#A=old\nA=new\n");
  });

  it("removes existing assignments mapped to undefined", () => {
    expect(
      reconcileEnvFile(
        'KEEP=yes\nREMOVE_ME=old\n  export REMOVE_ME = stale\nMULTILINE="one\ntwo"\nKEEP2=no\n',
        { KEEP: "still-yes", REMOVE_ME: undefined, MULTILINE: undefined, MISSING: undefined },
      ),
    ).toBe("KEEP=still-yes\nKEEP2=no\n");
    expect(reconcileEnvFile("REMOVE_ME=old\n", { REMOVE_ME: undefined })).toBe("");
  });
});

const { test } = Test.make({
  providers: Layer.empty,
  state: inMemoryState(),
});

const clientConfig = (token: string) => ({
  url: "https://relay.example.com",
  tracing: {
    mobileTracingUrl: "https://axiom.example.com/v1/traces",
    mobileTracingDataset: "relay-traces",
    mobileTracingToken: Redacted.make(`mobile-${token}`),
    clientTracingUrl: "https://axiom.example.com/v1/traces",
    clientTracingDataset: "relay-traces",
    clientTracingToken: Redacted.make(`client-${token}`),
    tokenDigest: tokenDigest([Redacted.make(`mobile-${token}`), Redacted.make(`client-${token}`)]),
  },
});

describe("PublishClientConfig", () => {
  test.provider("writes the env file on deploy and skips an unchanged redeploy", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-client-config-" });
      const target = path.join(dir, "client.env");
      yield* fs.writeFileString(target, "KEEP=yes\n");
      const configured = Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ T3CODE_RELAY_CLIENT_CONFIG_ENV: target }),
        ),
      );

      yield* stack.deploy(PublishClientConfig(clientConfig("v1"))).pipe(configured);
      const first = yield* fs.readFileString(target);
      expect(first).toContain("KEEP=yes\n");
      expect(first).toContain("T3CODE_RELAY_URL=https://relay.example.com\n");
      expect(first).toContain("T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=client-v1\n");
      expect(first).toContain("T3CODE_MOBILE_OTLP_TRACES_TOKEN=mobile-v1\n");

      yield* fs.writeFileString(target, `${first}MANUAL=1\n`);
      yield* stack.deploy(PublishClientConfig(clientConfig("v1"))).pipe(configured);
      expect(yield* fs.readFileString(target)).toContain("MANUAL=1\n");

      yield* stack.deploy(PublishClientConfig(clientConfig("v2"))).pipe(configured);
      const third = yield* fs.readFileString(target);
      expect(third).toContain("T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=client-v2\n");
      expect(third).not.toContain("client-v1");
      expect(third).toContain("KEEP=yes\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  test.provider("fails when the worker has no url rather than publishing an empty relay", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-client-config-" });
      const target = path.join(dir, "client.env");
      const exit = yield* stack
        .deploy(PublishClientConfig({ ...clientConfig("v1"), url: undefined }))
        .pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ T3CODE_RELAY_CLIENT_CONFIG_ENV: target }),
            ),
          ),
          Effect.exit,
        );
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("RelayUrlUnavailableError");
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  test.provider("refuses a value with a line break rather than corrupting the file", (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-client-config-" });
      const target = path.join(dir, "client.env");
      const base = clientConfig("v1");
      const exit = yield* stack
        .deploy(
          PublishClientConfig({
            ...base,
            tracing: {
              ...base.tracing,
              clientTracingDataset: "relay-traces\nINJECTED=1",
            },
          }),
        )
        .pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ T3CODE_RELAY_CLIENT_CONFIG_ENV: target }),
            ),
          ),
          Effect.exit,
        );
      expect(exit._tag).toBe("Failure");
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  test.provider(
    "writes only the relay URL and clears stale tracing entries when tracing is omitted",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-client-config-" });
        const target = path.join(dir, "client.env");
        yield* fs.writeFileString(
          target,
          "KEEP=yes\nT3CODE_MOBILE_OTLP_TRACES_TOKEN=old-mobile\nT3CODE_RELAY_CLIENT_OTLP_TRACES_URL=https://old.invalid/traces\nT3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=old-ds\nT3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=old-client\n",
        );

        yield* stack
          .deploy(PublishClientConfig({ url: "https://relay.example.com" }))
          .pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ T3CODE_RELAY_CLIENT_CONFIG_ENV: target }),
              ),
            ),
          );

        const updated = yield* fs.readFileString(target);
        expect(updated).toBe("KEEP=yes\nT3CODE_RELAY_URL=https://relay.example.com\n");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

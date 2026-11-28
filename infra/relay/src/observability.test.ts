// @effect-diagnostics anyUnknownInErrorContext:off - ScratchStack.deploy is typed with `any` in its error channel by Alchemy.
import { inMemoryState } from "alchemy/State";
import * as Test from "@alchemy.run/test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { RelayObservability } from "./observability.ts";

const { test } = Test.make({
  providers: Layer.empty,
  state: inMemoryState(),
});

describe("RelayObservability", () => {
  test.provider(
    "skips Axiom and mobile telemetry provisioning without Axiom credentials when RELAY_OBSERVABILITY_ENABLED=false",
    (stack) =>
      Effect.gen(function* () {
        const result = yield* stack
          .deploy(RelayObservability)
          .pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ RELAY_OBSERVABILITY_ENABLED: "false" }),
              ),
            ),
          );
        expect(Option.isOption(result)).toBe(true);
        expect(result).toEqual(Option.none());
      }),
  );
});

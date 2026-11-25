import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_METADATA_FILE,
  cliReleaseAssetUrl,
} from "@t3tools/shared/cliRelease";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import { findNewestCliReleaseVersion } from "./cliReleaseIndex.ts";

const ReleaseMetadata = Schema.Struct({
  version: Schema.String,
  t3code: Schema.Struct({
    databaseMigration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});
const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseMetadata));
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const permits = yield* Semaphore.make(2);
  const lookup = Effect.fn("NpmRelease.lookup")(function* (spec: string) {
    const channel = spec === "latest" ? "stable" : spec === "nightly" ? "nightly" : undefined;
    const version =
      channel === undefined
        ? spec
        : yield* findNewestCliReleaseVersion(channel).pipe(
            Effect.mapError(({ reason }) => new ServerNpmReleaseError({ reason })),
          );
    if (version === undefined) {
      return yield* new ServerNpmReleaseError({
        reason: `No published ${channel} release was found.`,
      });
    }

    const unavailable = new ServerNpmReleaseError({
      reason: `Could not read release metadata for t3@${version}.`,
    });
    const json = yield* Effect.gen(function* () {
      const response = yield* http.get(
        cliReleaseAssetUrl(version, CLI_RELEASE_METADATA_FILE, releaseBaseUrl),
      );
      if (response.status === 404) return null;
      if (response.status < 200 || response.status >= 300) return yield* unavailable;
      return yield* response.text;
    }).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.mapError(() => unavailable),
    );
    if (json === null) {
      if (channel === undefined) return null;
      return yield* new ServerNpmReleaseError({
        reason: `No compatibility metadata was published for t3@${version}.`,
      });
    }
    const metadata = Option.getOrUndefined(decodeMetadata(json));
    if (metadata?.version !== version) {
      return yield* new ServerNpmReleaseError({
        reason: `Invalid compatibility metadata for t3@${version}.`,
      });
    }
    return { version, databaseMigration: metadata.t3code.databaseMigration };
  });
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: (spec: string) => permits.withPermits(1)(lookup(spec)),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));

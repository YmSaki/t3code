import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

class CliReleaseIndexError extends Schema.TaggedError<
  CliReleaseIndexError,
  { readonly brand: unique symbol }
>()("CliReleaseIndexError", { reason: Schema.String }) {}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
const RELEASE_INDEX_MAX_PAGES = 10;

export const findNewestCliReleaseVersion = Effect.fn("cloud.cli_release_index.find_newest")(
  function* (channel: CliReleaseChannel) {
    const httpClient = yield* HttpClient.HttpClient;
    const environment = yield* HostProcess.Environment;
    const githubToken =
      environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
    for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
      const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
        HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      );
      const authenticatedRequest =
        githubToken === undefined
          ? request
          : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
      const body = yield* httpClient.execute(authenticatedRequest).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.mapError(() => new CliReleaseIndexError({ reason: "Could not list t3 releases." })),
        Effect.timeoutOrElse({
          duration: RELEASE_INDEX_TIMEOUT,
          orElse: () =>
            Effect.fail(new CliReleaseIndexError({ reason: "Timed out listing t3 releases." })),
        }),
      );
      const releases = yield* decodeReleaseIndex(body).pipe(
        Effect.mapError(
          () =>
            new CliReleaseIndexError({ reason: "The t3 release index had an unexpected shape." }),
        ),
      );
      const version = newestCliReleaseVersion(releases, channel);
      if (version !== undefined) return version;
      if (releases.length === 0) break;
    }
    return undefined;
  },
);

import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as NpmRelease from "./npmRelease.ts";

const version = "1.2.3";
const newerCli = "1.2.4";
const nightly = "1.2.4-nightly.20261030.1";
const desktopLatestUrl = "https://api.github.com/repos/YmSaki/t3codeJP/releases/latest";
const desktopLatest = {
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [{ name: "latest.yml" }],
};
const metadata = (version: string, databaseMigration: number) =>
  Response.json({ version, t3code: { databaseMigration } });
const notFound = () => new Response(null, { status: 404 });
const makeService = (client: HttpClient.HttpClient, env: Record<string, string> = {}) =>
  NpmRelease.make().pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(HostProcess.Environment, env),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

it.effect.each([
  { spec: version, expected: version },
  { spec: "latest", expected: version },
  { spec: "nightly", expected: nightly },
])(
  "uses fork migration metadata for $spec even when upstream has the same version",
  ({ spec, expected }) =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const service = yield* makeService(
        HttpClient.make((request) => {
          requested.push(request.url);
          const url = new URL(request.url);
          const response =
            request.url === desktopLatestUrl
              ? Response.json(desktopLatest)
              : url.pathname === "/repos/YmSaki/t3codeJP/releases"
                ? Response.json([
                    { tag_name: `v${nightly}` },
                    { tag_name: `v${newerCli}` },
                    { tag_name: `v${version}` },
                  ])
                : url.pathname ===
                    `/YmSaki/t3codeJP/releases/download/v${expected}/t3code-release.json`
                  ? metadata(expected, 42)
                  : url.pathname ===
                        `/pingdotgg/t3code/releases/download/v${expected}/t3code-release.json` ||
                      url.hostname === "registry.npmjs.org"
                    ? metadata(expected, 99)
                    : notFound();
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        }),
      );
      const expectedResult = { version: expected, databaseMigration: 42 };
      const expectedUrls = [
        ...(spec === "latest"
          ? [desktopLatestUrl]
          : spec === "nightly"
            ? ["https://api.github.com/repos/YmSaki/t3codeJP/releases?per_page=100&page=1"]
            : []),
        `https://github.com/YmSaki/t3codeJP/releases/download/v${expected}/t3code-release.json`,
      ];
      expect(yield* service.get({ spec })).toEqual(expectedResult);
      expect(yield* service.get({ spec })).toEqual(expectedResult);
      expect(requested).toEqual(expectedUrls);
      yield* TestClock.adjust("1 minute");
      expect(yield* service.get({ spec })).toEqual(expectedResult);
      expect(requested).toEqual([...expectedUrls, ...expectedUrls]);
    }),
);

it.effect.each([
  { label: "no Desktop Latest", response: notFound },
  {
    label: "a CLI-only Latest fallback",
    response: () => Response.json({ ...desktopLatest, assets: [{ name: "t3code-release.json" }] }),
  },
  { label: "a draft", response: () => Response.json({ ...desktopLatest, draft: true }) },
  { label: "a prerelease", response: () => Response.json({ ...desktopLatest, prerelease: true }) },
  {
    label: "a Nightly tag",
    response: () => Response.json({ ...desktopLatest, tag_name: `v${nightly}` }),
  },
  {
    label: "an unprefixed tag",
    response: () => Response.json({ ...desktopLatest, tag_name: version }),
  },
  {
    label: "a malformed Stable tag",
    response: () => Response.json({ ...desktopLatest, tag_name: "v1.02.3" }),
  },
  {
    label: "missing flags",
    response: () => Response.json({ tag_name: `v${version}`, assets: desktopLatest.assets }),
  },
  {
    label: "missing assets",
    response: () => Response.json({ ...desktopLatest, assets: undefined }),
  },
  {
    label: "malformed assets",
    response: () => Response.json({ ...desktopLatest, assets: [null] }),
  },
  { label: "a release list", response: () => Response.json([desktopLatest]) },
  { label: "a null release", response: () => Response.json(null) },
  { label: "invalid JSON", response: () => new Response("not json") },
  { label: "an empty body", response: () => new Response(null) },
  { label: "a host error", response: () => new Response("sensitive", { status: 500 }) },
])("refuses Desktop Latest when GitHub returns $label", (fixture) =>
  Effect.gen(function* () {
    const requested: string[] = [];
    const service = yield* makeService(
      HttpClient.make((request) => {
        requested.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url === desktopLatestUrl ? fixture.response() : metadata(newerCli, 42),
          ),
        );
      }),
    );
    const error = yield* service.get({ spec: "latest" }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ServerNpmReleaseError);
    expect(error.message).not.toContain("sensitive");
    expect(requested).toEqual([desktopLatestUrl]);
  }),
);

it.effect.each([undefined, "https://mirror.example.test/releases/?token=example"])(
  "keeps a missing asset unpublished at the configured origin %s",
  (baseUrl) =>
    Effect.gen(function* () {
      const requested: string[] = [];
      const service = yield* makeService(
        HttpClient.make((request) => {
          requested.push(request.url);
          const response =
            request.url.includes("/pingdotgg/") || request.url.includes("registry.npmjs.org")
              ? metadata(version, 99)
              : notFound();
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        }),
        baseUrl === undefined ? {} : { T3CODE_RELEASE_BASE_URL: baseUrl },
      );
      expect(yield* service.get({ spec: version })).toBeNull();
      expect(requested).toEqual([
        baseUrl === undefined
          ? `https://github.com/YmSaki/t3codeJP/releases/download/v${version}/t3code-release.json`
          : `https://mirror.example.test/releases/v${version}/t3code-release.json?token=example`,
      ]);
    }),
);

it.effect.each([
  { label: "missing metadata", response: notFound, reason: "No compatibility metadata" },
  {
    label: "a version mismatch",
    response: () => metadata("9.9.9", 42),
    reason: "Invalid compatibility metadata",
  },
  {
    label: "unknown migration compatibility",
    response: () => Response.json({ version }),
    reason: "Invalid compatibility metadata",
  },
  {
    label: "a noninteger migration",
    response: () => metadata(version, 1.5),
    reason: "Invalid compatibility metadata",
  },
  {
    label: "a negative migration",
    response: () => metadata(version, -1),
    reason: "Invalid compatibility metadata",
  },
  {
    label: "invalid JSON",
    response: () => new Response("not json"),
    reason: "Invalid compatibility metadata",
  },
  {
    label: "an empty body",
    response: () => new Response(null),
    reason: "Invalid compatibility metadata",
  },
  {
    label: "a host error",
    response: () => new Response("sensitive", { status: 500 }),
    reason: "Could not read release metadata",
  },
])("blocks a track lookup with $label", (fixture) =>
  Effect.gen(function* () {
    const requested: string[] = [];
    const service = yield* makeService(
      HttpClient.make((request) => {
        requested.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url === desktopLatestUrl ? Response.json(desktopLatest) : fixture.response(),
          ),
        );
      }),
    );
    const error = yield* service.get({ spec: "latest" }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(ServerNpmReleaseError);
    expect(error.reason).toContain(fixture.reason);
    expect(error.message).not.toContain("sensitive");
    expect(requested).toEqual([
      desktopLatestUrl,
      `https://github.com/YmSaki/t3codeJP/releases/download/v${version}/t3code-release.json`,
    ]);
  }),
);

it.effect("times out reading the release metadata body", () =>
  Effect.gen(function* () {
    const service = yield* makeService(
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(new ReadableStream()))),
      ),
    );
    const stalled = yield* service.get({ spec: version }).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(yield* Fiber.join(stalled)).toBeInstanceOf(ServerNpmReleaseError);
  }),
);

it.effect("runs at most two release lookups at once", () =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<void>();
    const release = yield* Deferred.make<void>();
    let running = 0;
    let peak = 0;
    const service = yield* makeService(
      HttpClient.make((request) =>
        Effect.gen(function* () {
          peak = Math.max(peak, ++running);
          yield* Queue.offer(started, undefined);
          yield* Deferred.await(release);
          running--;
          return HttpClientResponse.fromWeb(request, notFound());
        }),
      ),
    );
    const lookups = yield* Effect.forEach(
      ["1.0.0", "1.0.1", "1.0.2"],
      (spec) => service.get({ spec }),
      { concurrency: "unbounded" },
    ).pipe(Effect.forkChild);
    yield* Queue.take(started);
    yield* Queue.take(started);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(lookups)).toEqual([null, null, null]);
    expect(peak).toBe(2);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before fetching: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(
        HttpClient.make(() => Effect.die("invalid release spec fetched")),
      );
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);

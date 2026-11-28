import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const RULE_NAME = "t3code/no-io-in-functional-core";

const core = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.core.ts" });
const shell = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.ts" });
const coreTest = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.core.test.ts" });
const logic = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.logic.ts" });
const logicTest = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.logic.test.ts" });

describe(RULE_NAME, () => {
  describe("*.core.ts", () => {
    core.valid(
      "allows pure logic and inputs supplied by the caller",
      `
        import * as Option from "effect/Option";
        import * as Schema from "effect/Schema";

        export const expiresAt = (now: number, ttl: number) => now + ttl;
        export const stamp = (iso: string) => new Date(iso);
        export const parsed = Date.parse("2026-01-01");
        export const pick = (random: () => number) => Math.floor(random() * 10);
        export const lookup = (env: Record<string, string>) => Option.fromNullishOr(env.HOME);
        export const decode = Schema.decodeUnknownSync(Schema.String);
      `,
    );

    core.valid(
      "allows relative modules and unrelated effect modules",
      `
        import * as Effect from "effect/Effect";
        import { helper } from "./helper.ts";
        export const value = Effect.sync(helper);
      `,
    );

    core.invalid(
      "reports node: imports",
      `
        import * as NodePath from "node:path";
        export const join = NodePath.join;
      `,
      (output) => assert.match(output, /must not import node:path/),
    );

    core.invalid(
      "reports effect/FileSystem and sql imports",
      `
        import * as FileSystem from "effect/FileSystem";
        import * as SqlClient from "effect/unstable/sql/SqlClient";
        export const used = [FileSystem, SqlClient];
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 2),
    );

    core.invalid(
      "reports effect/sql imports",
      `
        import * as Sql from "effect/sql";
        export const used = Sql;
      `,
    );

    core.invalid(
      "reports platform-node imports",
      `
        import * as NodeServices from "@effect/platform-node/NodeServices";
        import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
        import * as PlatformNode from "@effect/platform-node";
        import * as PlatformNodeShared from "@effect/platform-node-shared";
        export const used = [NodeServices, NodeFileSystem, PlatformNode, PlatformNodeShared];
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 4),
    );

    core.invalid(
      "reports dynamic imports and re-exports of forbidden modules",
      `
        export const load = () => import("node:fs");
        export * from "node:os";
        export { join } from "node:path";
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 3),
    );

    core.invalid(
      "reports global fetch calls",
      `
        export const load = () => fetch("https://example.com");
        export const loadGlobal = () => globalThis.fetch("https://example.com");
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 2),
    );

    core.invalid(
      "reports Date.now calls and references",
      `
        export const a = Date.now();
        export const b = Date.now;
        export const c = Date["now"]();
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 3),
    );

    core.invalid(
      "reports new Date() with no arguments",
      `
        export const createdAt = new Date().toISOString();
      `,
      (output) => assert.match(output, /new Date\(\) without arguments/),
    );

    core.invalid(
      "reports Math.random and crypto.randomUUID",
      `
        export const a = Math.random();
        export const b = crypto.randomUUID();
        export const c = globalThis.crypto.randomUUID();
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 3),
    );

    core.invalid(
      "reports process.env access",
      `
        export const home = process.env.HOME;
        export const all = { ...process.env };
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 2),
    );

    core.invalid(
      "reports shell-only effect modules",
      `
        import * as Clock from "effect/Clock";
        import * as Config from "effect/Config";
        import * as Console from "effect/Console";
        import * as Context from "effect/Context";
        import * as HttpClient from "effect/http/HttpClient";
        import * as Layer from "effect/Layer";
        import * as Random from "effect/Random";
        export const used = [Clock, Config, Console, Context, HttpClient, Layer, Random];
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 7),
    );

    core.invalid(
      "reports bare Node builtin imports and their subpaths",
      `
        import * as FS from "fs";
        import * as FSPromises from "fs/promises";
        import * as Path from "path";
        import * as ChildProcess from "child_process";
        import * as OS from "os";
        import * as Crypto from "crypto";
        import * as Http from "http";
        import * as Https from "https";
        import * as Net from "net";
        export const used = [FS, FSPromises, Path, ChildProcess, OS, Crypto, Http, Https, Net];
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 9),
    );

    core.valid(
      "allows effect modules that only share a prefix with forbidden ones",
      `
        import * as ConfigProvider from "effect/ConfigProvider";
        import * as HttpClientRequest from "effect/http/HttpClientRequest";
        import * as pathe from "pathe";
        export const used = [ConfigProvider, HttpClientRequest, pathe];
      `,
    );

    core.invalid(
      "reports performance.now and crypto.getRandomValues",
      `
        export const a = performance.now();
        export const b = crypto.getRandomValues(new Uint8Array(4));
        export const c = globalThis.performance.now();
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 3),
    );

    core.invalid(
      "reports timers, storage, window, and navigator globals",
      `
        export const a = setTimeout(() => undefined, 1);
        export const b = setInterval(() => undefined, 1);
        export const c = localStorage.getItem("k");
        export const d = sessionStorage.getItem("k");
        export const e = window.location.href;
        export const f = navigator.userAgent;
        export const g = globalThis.setTimeout;
        export const h = globalThis.window;
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 8),
    );

    core.valid(
      "allows locals, parameters, and properties that reuse global names",
      `
        export const span = (window: number) => window * 2;
        export const pick = (input: { navigator: string; setTimeout: number }) => [
          input.navigator,
          input.setTimeout,
        ];
        export const shape = { window: 1, localStorage: "key" };
        export type Timer = ReturnType<typeof setTimeout>;
        export type Href = typeof window.location.href;
        export const local = () => {
          const sessionStorage = new Map<string, string>();
          return sessionStorage.get("k");
        };
        export const elapsed = (performance: { now: () => number }) => performance.now();
        export const fill = (crypto: { getRandomValues: (b: Uint8Array) => Uint8Array }) =>
          crypto.getRandomValues(new Uint8Array(4));
        export const read = (globalThis: { window: number; fetch: () => number }) => [
          globalThis.window,
          globalThis.fetch(),
        ];
        export const stored = (globalThis: { localStorage: number }) => {
          const { localStorage } = globalThis;
          return localStorage;
        };
        export const today = () => {
          const Date = { now: () => 0 };
          return Date.now();
        };
      `,
    );

    core.invalid(
      "reports globals destructured from globalThis, including renamed bindings",
      `
        const { localStorage } = globalThis;
        const { setTimeout: delay, performance: perf, crypto } = globalThis;
        export const a = localStorage.getItem("k");
        export const b = delay(() => undefined, 1);
        export const c = perf.now();
        export const d = crypto.randomUUID();
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 4),
    );

    core.invalid(
      "reports globals destructured from globalThis with string-literal computed keys",
      `
        const { ["localStorage"]: storage } = globalThis;
        const { ["setTimeout"]: delay } = globalThis;
        export const read = () => storage.getItem("key");
        export const wait = () => delay(() => undefined, 1);
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 2),
    );

    core.invalid(
      "reports globals whose names are reused only by type declarations",
      `
        type Date = string;
        interface performance {}
        type globalThis = string;
        export const now = () => Date.now();
        export const elapsed = () => performance.now();
        export const id = () => globalThis.crypto.randomUUID();
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 3),
    );

    core.invalid(
      "reports module-level let and var",
      `
        let counter = 0;
        export let cache = new Map();
        var legacy = 1;
        {
          var hoisted = 2;
        }
        export const bump = () => [counter, cache, legacy, hoisted];
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 4),
    );

    core.valid(
      "allows module-level const and function-local let",
      `
        export const LIMITS = { max: 10 } as const;
        export const count = (items: ReadonlyArray<number>) => {
          let total = 0;
          for (const item of items) total += item;
          {
            var last = total;
          }
          return last;
        };
      `,
    );
  });

  describe("*.logic.ts", () => {
    logic.invalid(
      "reports I/O and nondeterminism like core files",
      `
        import * as NodeFS from "node:fs";
        export const read = () => [NodeFS, Date.now()];
      `,
      (output) => assert.equal(output.match(/no-io-in-functional-core/g)?.length, 2),
    );
  });

  describe("non-core files", () => {
    shell.valid(
      "ignores shell files",
      `
        import * as NodeFS from "node:fs";
        import * as FileSystem from "effect/FileSystem";

        export const read = () => [NodeFS, FileSystem, fetch("x"), Date.now(), new Date()];
        export const env = process.env.HOME;
        export const random = [Math.random(), crypto.randomUUID()];
      `,
    );
  });

  describe("*.core.test.ts", () => {
    coreTest.valid(
      "ignores test files for core modules",
      `
        import * as NodeFS from "node:fs";

        export const read = () => [NodeFS, Math.random(), process.env.HOME];
      `,
    );
    logicTest.valid(
      "ignores test files for logic modules",
      `
        import * as NodeFS from "node:fs";

        export const read = () => [NodeFS, Date.now()];
      `,
    );
  });
});

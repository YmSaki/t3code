import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const RULE_NAME = "t3code/no-io-in-functional-core";

const core = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.core.ts" });
const shell = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.ts" });
const coreTest = createOxlintRuleHarness(RULE_NAME, { filename: "fixture.core.test.ts" });

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
  });
});

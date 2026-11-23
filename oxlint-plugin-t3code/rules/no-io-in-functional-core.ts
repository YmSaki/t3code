import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const CORE_FILE_PATTERN = /\.(?:core|logic)\.[cm]?[jt]sx?$/u;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const FORBIDDEN_MODULE_PREFIXES = [
  "node:",
  "effect/FileSystem",
  "effect/sql",
  "effect/unstable/sql",
  "@effect/sql",
  "@effect/platform-node",
  "@effect/platform-node-shared",
];
const FORBIDDEN_MEMBERS = new Set(["Date.now", "Math.random", "crypto.randomUUID", "process.env"]);

const MESSAGE_SUFFIX =
  "Functional core files (*.core.ts, *.logic.ts) stay pure: take time, randomness, environment, and I/O as inputs and let the shell (Effect Service) supply them. See docs/internals/functional-core-shell.md.";

const importMessage = (source: string) =>
  `Functional core must not import ${source}. ${MESSAGE_SUFFIX}`;
const usageMessage = (usage: string) => `Functional core must not use ${usage}. ${MESSAGE_SUFFIX}`;

const isForbiddenModule = (source: string) =>
  FORBIDDEN_MODULE_PREFIXES.some(
    (prefix) =>
      source === prefix || source.startsWith(prefix.endsWith(":") ? prefix : `${prefix}/`),
  );

const stringLiteralValue = (node: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(node), (expression) =>
    expression.type === "Literal" && typeof expression.value === "string"
      ? Option.some(expression.value)
      : Option.none(),
  );

const memberPath = (node: unknown): Option.Option<ReadonlyArray<string>> => {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return Option.none();
  if (expression.value.type === "Identifier") return Option.some([expression.value.name]);
  if (expression.value.type !== "MemberExpression") return Option.none();
  // `Date[key]` with a variable key is unknowable; only a literal key names a member.
  if (expression.value.computed && Option.isNone(stringLiteralValue(expression.value.property)))
    return Option.none();
  const property = getPropertyName(expression.value.property);
  if (Option.isNone(property)) return Option.none();
  return Option.map(memberPath(expression.value.object), (path) => [...path, property.value]);
};

const forbiddenMember = (node: unknown): Option.Option<string> =>
  Option.flatMap(memberPath(node), (path) => {
    const normalized = path[0] === "globalThis" ? path.slice(1) : path;
    const name = normalized.join(".");
    return normalized.length > 1 && FORBIDDEN_MEMBERS.has(name) ? Option.some(name) : Option.none();
  });

const isGlobalFetch = (callee: unknown) =>
  isIdentifier(unwrapExpression(callee), "fetch") ||
  Option.exists(memberPath(callee), (path) => path.join(".") === "globalThis.fetch");

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow I/O and nondeterminism (node:*, fetch, Date.now, Math.random, crypto.randomUUID, process.env) in *.core.ts and *.logic.ts files.",
    },
  },
  create(context) {
    if (!CORE_FILE_PATTERN.test(context.filename) || TEST_FILE_PATTERN.test(context.filename)) {
      return {};
    }

    const checkModuleSource = (node: ESTree.Node, source: unknown) => {
      const value = stringLiteralValue(source);
      if (Option.isNone(value) || !isForbiddenModule(value.value)) return;
      context.report({ node, message: importMessage(value.value) });
    };

    return {
      ImportDeclaration(node) {
        checkModuleSource(node, node.source);
      },
      ImportExpression(node) {
        checkModuleSource(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkModuleSource(node, node.source);
      },
      ExportAllDeclaration(node) {
        checkModuleSource(node, node.source);
      },
      CallExpression(node) {
        if (!isGlobalFetch(node.callee)) return;
        context.report({ node, message: usageMessage("global fetch") });
      },
      MemberExpression(node) {
        const member = forbiddenMember(node);
        if (Option.isNone(member)) return;
        context.report({ node, message: usageMessage(member.value) });
      },
      NewExpression(node) {
        if (node.arguments.length > 0) return;
        if (!isIdentifier(unwrapExpression(node.callee), "Date")) return;
        context.report({ node, message: usageMessage("new Date() without arguments") });
      },
    };
  },
});

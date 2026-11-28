import { defineRule, type ESTree, type Scope, type Variable } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

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
  "effect/Clock",
  "effect/Config",
  "effect/Console",
  "effect/Context",
  "effect/http/HttpClient",
  "effect/http/FetchHttpClient",
  "effect/Layer",
  "effect/Random",
  "fs",
  "path",
  "child_process",
  "os",
  "crypto",
  "http",
  "https",
  "net",
];
const FORBIDDEN_MEMBERS = new Set([
  "Date.now",
  "Math.random",
  "crypto.randomUUID",
  "crypto.getRandomValues",
  "performance.now",
  "process.env",
]);
const FORBIDDEN_GLOBALS = new Set([
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "setTimeout",
  "setInterval",
]);
type IdentifierNode = Extract<ESTree.Node, { type: "Identifier" }>;

const MODULE_SCOPE_TYPES = new Set(["global", "module"]);

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

// TS-ESLint tags type aliases, interfaces, and type parameters "Type"; they never shadow a value.
const isValueVariable = (variable: Variable) =>
  variable.defs.length === 0 || variable.defs.some((def) => (def.type as string) !== "Type");

const isTypeQuery = (identifier: ESTree.Node) => {
  let parent = identifier.parent;
  while (parent?.type === "TSQualifiedName") parent = parent.parent;
  return parent?.type === "TSTypeQuery";
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow I/O, nondeterminism, browser globals, services/layers, and module-level mutable state in *.core.ts and *.logic.ts files.",
    },
  },
  create(context) {
    if (!CORE_FILE_PATTERN.test(context.filename) || TEST_FILE_PATTERN.test(context.filename)) {
      return {};
    }

    const findVariable = (identifier: IdentifierNode): Option.Option<Variable> => {
      let scope: Scope | null = context.sourceCode.getScope(identifier);
      for (; scope !== null; scope = scope.upper) {
        const variable = scope.set.get(identifier.name);
        if (variable !== undefined && isValueVariable(variable)) return Option.some(variable);
      }
      return Option.none();
    };

    // The global a variable denotes, or none when it is a local binding.
    const globalName = (variable: Variable): Option.Option<string> =>
      variable.defs.length === 0 ? Option.some(variable.name) : globalThisAlias(variable);

    const referenceGlobalName = (identifier: IdentifierNode) =>
      Option.match(findVariable(identifier), {
        onNone: () => Option.some(identifier.name),
        onSome: globalName,
      });

    // `const { performance: perf } = globalThis` binds `perf` to the global `performance`.
    const globalThisAlias = (variable: Variable): Option.Option<string> => {
      const def = variable.defs[0];
      if (variable.defs.length !== 1 || def?.type !== "Variable") return Option.none();
      if (def.node.type !== "VariableDeclarator" || def.node.id.type !== "ObjectPattern")
        return Option.none();
      const init = unwrapExpression(def.node.init);
      if (
        Option.isNone(init) ||
        init.value.type !== "Identifier" ||
        init.value.name !== "globalThis" ||
        Option.exists(findVariable(init.value), (source) => source.defs.length > 0)
      )
        return Option.none();
      const binding = def.name.parent;
      const property = binding?.type === "AssignmentPattern" ? binding.parent : binding;
      if (property?.type !== "Property" || property.parent !== def.node.id) return Option.none();
      if (property.computed && Option.isNone(stringLiteralValue(property.key)))
        return Option.none();
      return getPropertyName(property.key);
    };

    // Member path rooted at a global; none when the root is shadowed by a local binding.
    const memberPath = (node: unknown): Option.Option<ReadonlyArray<string>> => {
      const expression = unwrapExpression(node);
      if (Option.isNone(expression)) return Option.none();
      if (expression.value.type === "Identifier")
        return Option.map(referenceGlobalName(expression.value), (name) => [name]);
      if (expression.value.type !== "MemberExpression") return Option.none();
      // `Date[key]` with a variable key is unknowable; only a literal key names a member.
      if (expression.value.computed && Option.isNone(stringLiteralValue(expression.value.property)))
        return Option.none();
      const property = getPropertyName(expression.value.property);
      if (Option.isNone(property)) return Option.none();
      return Option.map(memberPath(expression.value.object), (path) => [...path, property.value]);
    };

    const globalPath = (node: unknown) =>
      Option.map(memberPath(node), (path) => (path[0] === "globalThis" ? path.slice(1) : path));

    const checkModuleSource = (node: ESTree.Node, source: unknown) => {
      const value = stringLiteralValue(source);
      if (Option.isNone(value) || !isForbiddenModule(value.value)) return;
      context.report({ node, message: importMessage(value.value) });
    };

    return {
      VariableDeclaration(node) {
        // `var` hoists out of blocks, so a `var` outside any function is module state.
        const moduleLevel =
          node.kind === "var"
            ? MODULE_SCOPE_TYPES.has(context.sourceCode.getScope(node).variableScope.type)
            : node.kind === "let" &&
              (node.parent.type === "Program" || node.parent.type === "ExportNamedDeclaration");
        if (!moduleLevel) return;
        context.report({ node, message: usageMessage("module-level mutable state") });
      },
      "Program:exit"() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            const { identifier } = reference;
            if (reference.init || identifier.type !== "Identifier" || isTypeQuery(identifier))
              continue;
            const name =
              reference.resolved === null
                ? Option.some(identifier.name)
                : globalName(reference.resolved);
            if (Option.isNone(name) || !FORBIDDEN_GLOBALS.has(name.value)) continue;
            context.report({ node: identifier, message: usageMessage(`global ${name.value}`) });
          }
        }
      },
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
        if (!Option.exists(globalPath(node.callee), (path) => path.join(".") === "fetch")) return;
        context.report({ node, message: usageMessage("global fetch") });
      },
      MemberExpression(node) {
        const path = memberPath(node);
        if (Option.isNone(path)) return;
        const [root, global] = path.value;
        if (path.value.length === 2 && root === "globalThis" && FORBIDDEN_GLOBALS.has(global!)) {
          context.report({ node, message: usageMessage(`global ${global}`) });
          return;
        }
        const normalized = root === "globalThis" ? path.value.slice(1) : path.value;
        const name = normalized.join(".");
        if (normalized.length < 2 || !FORBIDDEN_MEMBERS.has(name)) return;
        context.report({ node, message: usageMessage(name) });
      },
      NewExpression(node) {
        if (node.arguments.length > 0) return;
        if (!Option.exists(globalPath(node.callee), (path) => path.join(".") === "Date")) return;
        context.report({ node, message: usageMessage("new Date() without arguments") });
      },
    };
  },
});

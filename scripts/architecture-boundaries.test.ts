// @effect-diagnostics nodeBuiltinImport:off - Reads workspace manifests and git-listed sources directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  ALLOWED_CROSS_DOMAIN_EDGES,
  PACKAGE_EDGE_BASELINE,
  UPSTREAM_REFERENCE_BASELINE,
} from "./architecture-boundaries.baseline.ts";

// Package roles and dependency rules come from docs/internals/overview.md
// ("Dependency model and package roles"); the debt policy from docs/internals/review.md.
type Role =
  | "protocol"
  | "contracts"
  | "shared"
  | "core"
  | "adapter"
  | "definitions"
  | "client-runtime"
  | "app"
  | "hosted"
  | "support";

interface Pkg {
  readonly name: string;
  readonly dir: string;
}

type DependencyField = "dependencies" | "devDependencies" | "peerDependencies";

const DOMAINS = ["secret-provider", "source-control", "issue-tracker", "provider"] as const;

const classify = (dir: string): { readonly role: Role; readonly domain?: string } => {
  const base = NodePath.posix.basename(dir);
  const domain = (): string => DOMAINS.find((prefix) => base.startsWith(`${prefix}-`)) ?? base;
  if (dir.startsWith("apps/")) return { role: "app" };
  if (dir.startsWith("infra/")) return { role: "hosted" };
  if (["scripts", "evals", "oxlint-plugin-t3code"].includes(dir)) return { role: "support" };
  if (dir.startsWith("packages/")) {
    if (base === "effect-acp" || base === "effect-codex-app-server") return { role: "protocol" };
    if (base === "contracts") return { role: "contracts" };
    if (base === "shared") return { role: "shared" };
    if (base === "client-runtime") return { role: "client-runtime" };
    if (base.endsWith("-testing")) return { role: "support" };
    if (base.endsWith("-core") || base === "ssh" || base === "tailscale") {
      return { role: "core", domain: domain() };
    }
    if (base.endsWith("-definitions")) return { role: "definitions", domain: domain() };
    if (DOMAINS.some((prefix) => base.startsWith(`${prefix}-`))) {
      return { role: "adapter", domain: domain() };
    }
  }
  throw new Error(`${dir} has no role; classify it in architecture-boundaries.test.ts.`);
};

const ALLOWED_ROLES: Record<Role, ReadonlyArray<Role>> = {
  protocol: [],
  contracts: [],
  shared: ["contracts"],
  core: ["protocol", "contracts", "shared", "core"],
  adapter: ["contracts", "shared", "protocol", "core", "adapter"],
  definitions: ["contracts", "shared", "protocol", "core", "adapter"],
  "client-runtime": ["protocol", "contracts", "shared", "core", "adapter", "definitions"],
  app: ["protocol", "contracts", "shared", "core", "adapter", "definitions", "client-runtime"],
  hosted: ["protocol", "contracts", "shared", "core", "adapter", "definitions"],
  support: [
    "protocol",
    "contracts",
    "shared",
    "core",
    "adapter",
    "definitions",
    "client-runtime",
    "app",
    "hosted",
    "support",
  ],
};

const DOMAIN_ROLES: ReadonlyArray<Role> = ["core", "adapter", "definitions"];

const edgeViolation = (from: Pkg, to: Pkg, field: DependencyField): string | undefined => {
  const source = classify(from.dir);
  const target = classify(to.dir);
  // overview.md: the server bundles the web build without a runtime dependency on it.
  if (from.dir === "apps/server" && to.dir === "apps/web" && field === "devDependencies") return;
  // Test fixtures stay at the test boundary.
  if (target.role === "support" && source.role !== "support") {
    return to.dir.endsWith("-testing") && field === "devDependencies"
      ? undefined
      : `${source.role} must not depend on support packages outside devDependencies`;
  }
  if (!ALLOWED_ROLES[source.role].includes(target.role)) {
    return `${source.role} must not depend on ${target.role}`;
  }
  if (
    DOMAIN_ROLES.includes(source.role) &&
    DOMAIN_ROLES.includes(target.role) &&
    source.domain !== target.domain &&
    !ALLOWED_CROSS_DOMAIN_EDGES.has(`${from.name} -> ${to.name}`)
  ) {
    return `the ${source.domain} domain must not depend on the ${target.domain} domain`;
  }
  return undefined;
};

const findCycles = (graph: ReadonlyMap<string, ReadonlyArray<string>>) => {
  const cycles: Array<string> = [];
  const done = new Set<string>();
  const visit = (node: string, path: ReadonlyArray<string>) => {
    const start = path.indexOf(node);
    if (start !== -1) {
      cycles.push([...path.slice(start), node].join(" -> "));
      return;
    }
    if (done.has(node)) return;
    for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
    done.add(node);
  };
  for (const node of graph.keys()) visit(node, []);
  return cycles;
};

// Counts above the baseline are regressions; counts below it are stale entries to delete.
const ratchet = (actual: ReadonlyMap<string, number>, baseline: ReadonlyMap<string, number>) => ({
  regressions: [...actual]
    .filter(([key, count]) => count > (baseline.get(key) ?? 0))
    .map(([key, count]) => `${key} (baseline ${baseline.get(key) ?? 0}, now ${count})`),
  stale: [...baseline]
    .filter(([key, count]) => (actual.get(key) ?? 0) < count)
    .map(([key, count]) => `${key} (baseline ${count}, now ${actual.get(key) ?? 0})`),
});

const SPECIFIER =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;

const importSpecifiers = (source: string) =>
  [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

const packageNameOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const SUPPORT_OR_SERVER_DIR =
  /^(apps\/server|scripts|evals|oxlint-plugin-t3code|packaging)(\/|$)|^packages\/[^/]+-testing(\/|$)/;
const SUPPORT_OR_SERVER_PACKAGE =
  /^(t3|@t3tools\/(scripts|evals|oxlint-plugin-t3code|[^/]+-testing))$/;

const forbiddenClientImport = (file: string, specifier: string): string | undefined => {
  if (specifier.startsWith(".")) {
    const resolved = NodePath.posix.join(NodePath.posix.dirname(file), specifier);
    return SUPPORT_OR_SERVER_DIR.test(resolved) ? `reaches ${resolved}` : undefined;
  }
  const name = packageNameOf(specifier);
  if (SUPPORT_OR_SERVER_PACKAGE.test(name)) return `imports ${name}`;
  // overview.md: clients must not import server-only code, even through package subpaths.
  if (name.startsWith("@t3tools/") && specifier.slice(name.length).split("/")[1] === "server") {
    return "imports a server-only subpath";
  }
  return undefined;
};

const TEST_FILE =
  /(^|\/)(test|tests|__tests__|fixtures|testFixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.test\.py$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const UPSTREAM_REFERENCE = /\b(?:[a-z0-9-]+\.)*t3\.codes\b|pingdotgg\/t3code\b/gi;

const root = NodePath.resolve(import.meta.dirname, "..");
const read = (file: string) => NodeFS.readFileSync(NodePath.join(root, file));
// Text files only; support packages never violate a direction, so their sources are not read.
const sources = new Map(
  NodeChildProcess.execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps",
      "packages",
      "infra",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((file) => file !== "" && NodeFS.existsSync(NodePath.join(root, file)))
    .flatMap((file) => {
      const content = read(file);
      return content.includes(0) ? [] : [[file, content.toString("utf8")] as const];
    }),
);
const text = (file: string) => sources.get(file) ?? "";
const files = [...sources.keys()];

const packages = readWorkspace().map(({ name, dir }) => {
  const manifest = JSON.parse(read(`${dir}/package.json`).toString("utf8")) as Partial<
    Record<DependencyField, Record<string, string>>
  >;
  const deps = (["dependencies", "devDependencies", "peerDependencies"] as const).flatMap((field) =>
    Object.entries(manifest[field] ?? {})
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([dep]) => ({ dep, field })),
  );
  return { name, dir, deps };
});
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));

const toMap = (keys: Iterable<string>) => {
  const map = new Map<string, number>();
  for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
  return map;
};

const RATCHET_HELP =
  "Fix the new violation. If it is intended, agree an exception with the maintainers and add a tracked entry to scripts/architecture-boundaries.baseline.ts.";
const STALE_HELP =
  "These baseline entries no longer match a violation. Delete or shrink them in scripts/architecture-boundaries.baseline.ts.";

describe("ratchet", () => {
  it.each([
    { actual: [["a", 1]], baseline: [], regressions: ["a (baseline 0, now 1)"], stale: [] },
    { actual: [["a", 3]], baseline: [["a", 2]], regressions: ["a (baseline 2, now 3)"], stale: [] },
    { actual: [["a", 1]], baseline: [["a", 2]], regressions: [], stale: ["a (baseline 2, now 1)"] },
    { actual: [], baseline: [["a", 1]], regressions: [], stale: ["a (baseline 1, now 0)"] },
    { actual: [["a", 2]], baseline: [["a", 2]], regressions: [], stale: [] },
  ] as const)("$actual against $baseline", ({ actual, baseline, regressions, stale }) => {
    expect(ratchet(new Map(actual), new Map(baseline))).toEqual({ regressions, stale });
  });
});

describe("rules", () => {
  const pkg = (dir: string) => ({ dir, name: `@t3tools/${NodePath.posix.basename(dir)}` });

  it.each([
    ["packages/effect-acp", "packages/shared", "dependencies", true],
    ["packages/shared", "packages/contracts", "dependencies", false],
    ["packages/provider-core", "packages/source-control-core", "dependencies", true],
    ["packages/source-control-github", "packages/provider-core", "dependencies", true],
    ["packages/source-control-github", "packages/source-control-core", "dependencies", false],
    ["packages/provider-grok", "packages/provider-acp", "dependencies", false],
    ["packages/provider-grok", "packages/provider-testing", "devDependencies", false],
    ["packages/provider-grok", "packages/provider-testing", "dependencies", true],
    ["packages/client-runtime", "apps/web", "dependencies", true],
    ["packages/client-runtime", "packages/provider-cursor", "dependencies", false],
    ["infra/relay", "packages/client-runtime", "dependencies", true],
    ["apps/web", "apps/server", "dependencies", true],
    ["apps/server", "apps/web", "devDependencies", false],
    ["apps/server", "apps/web", "dependencies", true],
    ["scripts", "apps/server", "dependencies", false],
  ] as const)("%s -> %s (%s) violates: %s", (from, to, field, violates) => {
    expect(edgeViolation(pkg(from), pkg(to), field) !== undefined).toBe(violates);
  });

  it("throws for a package with no role", () => {
    expect(() => classify("packages/new-thing")).toThrow(/no role/);
  });

  it.each([
    [
      "a -> b -> a",
      [
        ["a", ["b"]],
        ["b", ["a"]],
      ],
      ["a -> b -> a"],
    ],
    [
      "a -> b -> c",
      [
        ["a", ["b"]],
        ["b", ["c"]],
        ["c", []],
      ],
      [],
    ],
  ] as const)("finds cycles in %s", (_, graph, cycles) => {
    expect(findCycles(new Map<string, ReadonlyArray<string>>(graph))).toEqual(cycles);
  });

  it.each([
    ["apps/mobile/src/features/home/a.ts", "../../state/server", false],
    ["apps/mobile/src/a.ts", "@t3tools/client-runtime/state/server", false],
    ["apps/web/src/a.ts", "../../server/src/ws", true],
    ["packages/client-runtime/src/a.ts", "../../provider-testing/src/x", true],
    ["apps/web/src/a.ts", "@t3tools/provider-core/client", false],
    ["apps/web/src/a.ts", "@t3tools/provider-core/server/randomUuid", true],
    ["apps/web/src/a.ts", "t3/src/ws", true],
    ["apps/web/src/a.ts", "@t3tools/source-control-testing", true],
  ] as const)("%s importing %s violates: %s", (file, specifier, violates) => {
    expect(forbiddenClientImport(file, specifier) !== undefined).toBe(violates);
  });

  it("collects static, re-export, side-effect, and dynamic imports", () => {
    const source = `import type { A } from "a";\nexport { b } from 'b';\nimport "c";\nconst d = await import("d");\nrequire("e");`;
    expect(importSpecifiers(source)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("workspace", () => {
  it("keeps package dependency directions within the baseline", () => {
    const violations = new Map<string, string>();
    for (const pkg of packages) {
      for (const { dep, field } of pkg.deps) {
        const target = byName.get(dep);
        const reason = target && edgeViolation(pkg, target, field);
        if (target && reason) violations.set(`${pkg.name} -> ${dep}`, reason);
      }
    }
    const declared = new Set(
      packages.flatMap((pkg) => pkg.deps.map(({ dep }) => `${pkg.name} -> ${dep}`)),
    );
    expect(
      [...ALLOWED_CROSS_DOMAIN_EDGES].filter((edge) => !declared.has(edge)),
      STALE_HELP,
    ).toEqual([]);

    // A baselined edge is pinned to the imports it carries today, so it cannot widen.
    const actual: Array<string> = [];
    for (const edge of violations.keys()) {
      actual.push(edge);
      const [fromName = "", toName = ""] = edge.split(" -> ");
      const from = byName.get(fromName);
      for (const file of files) {
        if (!from || !file.startsWith(`${from.dir}/`) || !CODE_FILE.test(file)) continue;
        const specifiers = new Set(
          importSpecifiers(text(file)).filter((specifier) => packageNameOf(specifier) === toName),
        );
        for (const specifier of specifiers) actual.push(`${edge} | ${file} -> ${specifier}`);
      }
    }
    const baseline = PACKAGE_EDGE_BASELINE.flatMap(({ edge, imports }) => [
      edge,
      ...imports.map((entry) => `${edge} | ${entry}`),
    ]);

    const { regressions, stale } = ratchet(toMap(actual), toMap(baseline));
    expect(
      regressions.map(
        (key) => `${key}: ${violations.get(key.split(/ \| | \(baseline/)[0] ?? "") ?? ""}`,
      ),
      RATCHET_HELP,
    ).toEqual([]);
    expect(stale, STALE_HELP).toEqual([]);
  });

  it("has no dependency cycles between workspace packages", () => {
    const graph = new Map(
      packages.map((pkg) => [
        pkg.name,
        pkg.deps.map(({ dep }) => dep).filter((dep) => byName.has(dep)),
      ]),
    );
    expect(findCycles(graph)).toEqual([]);
  });

  it("keeps client code away from the server and support code", () => {
    // Runtime code only; build configs and Expo config plugins legitimately read scripts/lib.
    const clientRoots = [
      "apps/web/src/",
      "apps/mobile/src/",
      "apps/mobile/modules/",
      "apps/mobile/index.ts",
      "packages/client-runtime/src/",
    ];
    const violations = files
      .filter(
        (file) =>
          clientRoots.some((dir) => file.startsWith(dir)) &&
          CODE_FILE.test(file) &&
          !TEST_FILE.test(file),
      )
      .flatMap((file) =>
        importSpecifiers(text(file)).flatMap((specifier) => {
          const reason = forbiddenClientImport(file, specifier);
          return reason ? [`${file} -> ${specifier}: ${reason}`] : [];
        }),
      );
    expect(violations).toEqual([]);
  });

  it("keeps upstream references in production code within the baseline", () => {
    const actual: Array<string> = [];
    for (const [file, content] of sources) {
      if (TEST_FILE.test(file) || file.endsWith(".md")) continue;
      if (/^packages\/[^/]+-testing\//.test(file)) continue;
      for (const match of content.matchAll(UPSTREAM_REFERENCE)) {
        actual.push(`${file} -> ${match[0].toLowerCase()}`);
      }
    }
    const baseline = new Map(
      UPSTREAM_REFERENCE_BASELINE.flatMap(({ file, refs }) =>
        Object.entries(refs).map(([ref, count]) => [`${file} -> ${ref}`, count] as const),
      ),
    );

    const { regressions, stale } = ratchet(toMap(actual), baseline);
    expect(regressions, RATCHET_HELP).toEqual([]);
    expect(stale, STALE_HELP).toEqual([]);
  });
});

// @effect-diagnostics nodeBuiltinImport:off - Reads workspace manifests and git-listed sources directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  ALLOWED_CROSS_DOMAIN_IMPORTS,
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
  if (["scripts", "evals", "oxlint-plugin-t3code", "packaging"].includes(dir)) {
    return { role: "support" };
  }
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

// A manifest edge (no specifier) is allowed when any allowed import covers it; a source import
// only by its exact public specifier, so relative paths and other subpaths stay forbidden.
const crossDomainAllowed = (from: Pkg, to: Pkg, specifier: string | undefined) =>
  specifier === undefined
    ? [...ALLOWED_CROSS_DOMAIN_IMPORTS].some((entry) =>
        entry.startsWith(`${from.name} -> ${to.name}/`),
      )
    : ALLOWED_CROSS_DOMAIN_IMPORTS.has(`${from.name} -> ${specifier}`);

const edgeViolation = (
  from: Pkg,
  to: Pkg,
  field: DependencyField,
  specifier?: string,
): string | undefined => {
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
    !crossDomainAllowed(from, to, specifier)
  ) {
    return `the ${source.domain} domain must not depend on the ${target.domain} domain`;
  }
  return undefined;
};

const findCycles = (graph: ReadonlyMap<string, Iterable<string>>) => {
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

const SIDE_EFFECT = "<side-effect>";
const IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?((?:(?!\b(?:import|export)\b)(?:[\w$*\s,{}]|\/\/[^\n]*|\/\*[\s\S]*?\*\/))*?)\s*\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*[,)]/g;

const COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

// A namespace import records the members it reads, plus "*" when the namespace is used whole.
const namespaceSymbols = (name: string, body: string) => {
  const escaped = name.replace(/\$/g, "\\$");
  const uses = [
    // A spread (`...ns`) is a whole use; a property (`x.ns`) or a specifier ("pkg/ns") is not.
    ...body.matchAll(
      new RegExp(
        `(?<![\\w$/"'\`])(?<!(?<!\\.\\.)\\.)${escaped}(?![\\w$])(?:\\s*\\.\\s*([\\w$]+))?`,
        "g",
      ),
    ),
  ];
  const members = new Set(uses.flatMap((use) => (use[1] === undefined ? [] : [use[1]])));
  // The import clause itself is one bare use.
  const whole = uses.filter((use) => use[1] === undefined).length > 1 || members.size === 0;
  return [...members, ...(whole ? ["*"] : [])];
};

// Imported names, not local aliases; re-export-all and dynamic imports are "*".
const symbolsOf = (source: string, body: string, isExport: boolean) => {
  const clause = source.replace(COMMENT, "");
  const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
  const head = clause
    .replace(/\{[^}]*\}/, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      if (!part.startsWith("*")) return ["default"];
      const alias = /^\*\s*as\s+([\w$]+)$/.exec(part)?.[1];
      return isExport || alias === undefined ? ["*"] : namespaceSymbols(alias, body);
    });
  const names = named
    .split(",")
    .map(
      (part) =>
        part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0] ?? "",
    )
    .filter(Boolean);
  const symbols = [...head, ...names];
  return symbols.length > 0 ? symbols : [SIDE_EFFECT];
};

// `markup` is an Astro template: it reads namespace members but holds no imports.
const importsOf = (source: string, markup = "") => {
  // Strings are kept, so a stray quote such as JSX "Don't" cannot hide a member use.
  const body = `${source.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_, literal: string | undefined) => literal ?? "",
  )}\n${markup}`;
  return [...source.matchAll(IMPORT)].map((match) =>
    match[2] !== undefined
      ? {
          specifier: match[2],
          symbols: symbolsOf(match[1] ?? "", body, match[0].startsWith("export")),
        }
      : match[3] !== undefined
        ? { specifier: match[3], symbols: [SIDE_EFFECT] }
        : { specifier: match[4] ?? "", symbols: ["*"] },
  );
};

const FRONTMATTER = /^\s*---\r?\n((?:[\s\S]*?\r?\n)??)---/;
const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

// Astro components import only in their frontmatter and script blocks; the rest is template.
const fileImports = (file: string, content: string) =>
  file.endsWith(".astro")
    ? importsOf(
        [
          FRONTMATTER.exec(content)?.[1] ?? "",
          ...[...content.matchAll(SCRIPT)].map((match) => match[1]),
        ].join("\n"),
        content.replace(FRONTMATTER, "").replace(SCRIPT, ""),
      )
    : importsOf(content);

const packageNameOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const TEST_FILE =
  /(^|\/)(test|tests|__tests__|fixtures|testFixtures|testkit|integration)\/|\.(test|spec|testkit)\.[cm]?[jt]sx?$|\.test\.py$/;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|astro)$/;
// Package-root configs and tool or Expo plugin directories; everything else in a package ships.
const BUILD_FILE = /^[^/]+$|^(scripts|plugins)\//;
const CLIENT_FILE = /^(apps\/web|apps\/mobile|packages\/client-runtime)\//;
const UPSTREAM_REFERENCE = /\b(?:[a-z0-9-]+\.)*t3\.codes\b|pingdotgg\/t3code\b/gi;

const root = NodePath.resolve(import.meta.dirname, "..");
const read = (file: string) => NodeFS.readFileSync(NodePath.join(root, file));
// Text files only; support packages never violate a direction, so their sources are not read.
const sources: ReadonlyMap<string, string> = new Map(
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
// packaging/ is support code outside the workspace.
const owners: ReadonlyArray<Pkg> = [...packages, { name: "packaging", dir: "packaging" }].sort(
  (a, b) => b.dir.length - a.dir.length,
);
const ownerOf = (path: string) =>
  owners.find((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`));

const resolveImport = (file: string, specifier: string) => {
  if (specifier.startsWith(".")) {
    const path = NodePath.posix.join(NodePath.posix.dirname(file), specifier);
    const pkg = ownerOf(path);
    return (
      pkg && {
        pkg,
        serverOnly: pkg.dir === "apps/server" || path.startsWith(`${pkg.dir}/src/server/`),
      }
    );
  }
  const name = packageNameOf(specifier);
  const pkg = byName.get(name);
  return (
    pkg && {
      pkg,
      serverOnly:
        pkg.dir === "apps/server" || specifier.slice(name.length).split("/")[1] === "server",
    }
  );
};

// Runtime code is what ships; tests are the test phase. Build configs and tool scripts beside a
// package legitimately read scripts/lib, and their declared dependencies are checked by manifest.
const phaseOf = (pkg: Pkg, file: string): DependencyField | undefined => {
  if (TEST_FILE.test(file)) return "devDependencies";
  const inner = file.slice(pkg.dir.length + 1);
  return BUILD_FILE.test(inner) && inner !== "index.ts" ? undefined : "dependencies";
};

const sourceImports = (files: ReadonlyMap<string, string>) => {
  const violations = new Map<string, string>();
  const edges = new Map<string, Set<string>>();
  const used = new Set<string>();
  for (const [file, content] of files) {
    const from = ownerOf(file);
    if (!from || !CODE_FILE.test(file)) continue;
    const field = phaseOf(from, file);
    if (!field) continue;
    for (const { specifier, symbols } of fileImports(file, content)) {
      const target = resolveImport(file, specifier);
      if (!target || target.pkg === from) continue;
      used.add(`${from.name} -> ${specifier}`);
      // Test-only imports are ratcheted as directions but do not form runtime cycles.
      if (field === "dependencies") {
        edges.set(from.name, (edges.get(from.name) ?? new Set()).add(target.pkg.name));
      }
      // overview.md: clients must not import server-only code, even through package subpaths.
      const reason =
        field === "dependencies" && CLIENT_FILE.test(file) && target.serverOnly
          ? "client code must not import server-only implementations"
          : edgeViolation(from, target.pkg, field, specifier);
      if (!reason) continue;
      for (const symbol of symbols) {
        violations.set(
          `${from.name} -> ${target.pkg.name} | ${file} -> ${specifier} | ${symbol}`,
          reason,
        );
      }
    }
  }
  return { violations, edges, used };
};

const manifestViolations = new Map<string, string>();
for (const pkg of packages) {
  for (const { dep, field } of pkg.deps) {
    const target = byName.get(dep);
    const reason = target && edgeViolation(pkg, target, field);
    if (target && reason) {
      manifestViolations.set(
        `${pkg.name} -> ${dep} | ${pkg.dir}/package.json -> ${dep} | ${field}`,
        reason,
      );
    }
  }
}

const dependencyGraph = (sourceEdges: ReadonlyMap<string, ReadonlySet<string>>) =>
  new Map(
    packages.map((pkg) => [
      pkg.name,
      new Set([
        ...pkg.deps.map(({ dep }) => dep).filter((dep) => byName.has(dep)),
        ...(sourceEdges.get(pkg.name) ?? []),
      ]),
    ]),
  );

const toMap = (keys: Iterable<string>) => {
  const map = new Map<string, number>();
  for (const key of keys) map.set(key, (map.get(key) ?? 0) + 1);
  return map;
};

const edgeBaseline = toMap(
  PACKAGE_EDGE_BASELINE.flatMap(({ edge, imports }) =>
    Object.entries(imports).flatMap(([entry, symbols]) =>
      symbols.map((symbol) => `${edge} | ${entry} | ${symbol}`),
    ),
  ),
);

const edgeRatchet = (files: ReadonlyMap<string, string>) => {
  const { violations } = sourceImports(files);
  const { regressions, stale } = ratchet(
    toMap([...manifestViolations.keys(), ...violations.keys()]),
    edgeBaseline,
  );
  const reasons = new Map([...manifestViolations, ...violations]);
  return {
    regressions: regressions.map(
      (key) => `${key}: ${reasons.get(key.replace(/ \(baseline.*$/, ""))}`,
    ),
    stale,
  };
};

const withFile = (file: string, content: string) => new Map([[file, content]]);

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
    ["packages/issue-tracker-linear", "packages/source-control-core", "dependencies", false],
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
    [
      "packages/provider-core/src/a.ts",
      "../../provider-cursor/src/server/x.ts",
      "core must not depend on adapter",
    ],
    [
      "apps/web/src/a.ts",
      "../../../packages/provider-core/src/server/x.ts",
      "client code must not import server-only implementations",
    ],
    [
      "apps/web/src/a.ts",
      "../../server/src/ws",
      "client code must not import server-only implementations",
    ],
    [
      "apps/web/src/a.ts",
      "@t3tools/provider-core/server/randomUuid",
      "client code must not import server-only implementations",
    ],
    ["apps/web/src/a.ts", "t3/src/ws", "client code must not import server-only implementations"],
    [
      "apps/web/src/a.ts",
      "../../../scripts/lib/x",
      "app must not depend on support packages outside devDependencies",
    ],
    [
      "apps/web/src/a.ts",
      "@t3tools/source-control-testing",
      "app must not depend on support packages outside devDependencies",
    ],
    [
      "packages/client-runtime/src/a.ts",
      "../../provider-testing/src/x",
      "client-runtime must not depend on support packages outside devDependencies",
    ],
    [
      "packages/provider-grok/src/a.ts",
      "@t3tools/provider-testing",
      "adapter must not depend on support packages outside devDependencies",
    ],
    [
      "packages/issue-tracker-linear/src/a.ts",
      "@t3tools/source-control-core/server/discovery",
      "the issue-tracker domain must not depend on the source-control domain",
    ],
    [
      "packages/issue-tracker-linear/src/a.ts",
      "../../source-control-core/src/server/IssueTracker.ts",
      "the issue-tracker domain must not depend on the source-control domain",
    ],
    [
      "packages/issue-tracker-linear/src/a.ts",
      "@t3tools/source-control-core/server/IssueTracker",
      undefined,
    ],
    ["packages/provider-grok/src/a.test.ts", "@t3tools/provider-testing", undefined],
    ["apps/mobile/src/features/home/a.ts", "../../state/server", undefined],
    ["apps/mobile/src/a.ts", "@t3tools/client-runtime/state/server", undefined],
    ["apps/web/src/a.ts", "@t3tools/provider-core/client", undefined],
    ["apps/web/vite.config.ts", "../../scripts/lib/x", undefined],
  ] as const)("%s importing %s: %s", (file, specifier, reason) => {
    expect([
      ...sourceImports(withFile(file, `import { x } from "${specifier}";`)).violations.values(),
    ]).toEqual(reason === undefined ? [] : [reason]);
  });

  it("collects imported names from every import form", () => {
    const source = `import type {\n  A, // why\n  /* x */ type B as C,\n} from "a";\nexport {\n  b,\n} from 'b';\nimport "c";\nconst d = await import("d", { with: { type: "json" } });\nrequire("e");\nimport F, * as G from "f";\nexport * from "g";\nimport * as H from "h";\nimport * as I from "i";\nexport * as J from "j";\nimport * as K from "k";\nH.x(H . y, I, z.H.w, K.a, { ...K }, "H"); // H.comment\nconst el = <p>Don't {H.z} it's</p>;`;
    expect(importsOf(source)).toEqual([
      { specifier: "a", symbols: ["A", "B"] },
      { specifier: "b", symbols: ["b"] },
      { specifier: "c", symbols: [SIDE_EFFECT] },
      { specifier: "d", symbols: ["*"] },
      { specifier: "e", symbols: ["*"] },
      { specifier: "f", symbols: ["default", "*"] },
      { specifier: "g", symbols: ["*"] },
      { specifier: "h", symbols: ["x", "y", "z"] },
      { specifier: "i", symbols: ["*"] },
      { specifier: "j", symbols: ["*"] },
      { specifier: "k", symbols: ["a", "*"] },
    ]);
  });

  it("records namespace members an .astro template reads", () => {
    const file = "apps/marketing/src/pages/a.astro";
    const content = `---\nimport * as Ws from "../../../server/src/ws";\nconst a = Ws.A;\n---\n<p>{Ws.B}</p><Ws.C />`;
    expect([...sourceImports(withFile(file, content)).violations.keys()]).toEqual(
      ["A", "B", "C"].map(
        (symbol) => `@t3tools/marketing -> t3 | ${file} -> ../../../server/src/ws | ${symbol}`,
      ),
    );
  });

  it("fails a baselined namespace import that reads another member", () => {
    const file = "packages/effect-codex-app-server/src/_internal/stdio.ts";
    const specifier = "@t3tools/shared/HostProcess";
    const injected = `${text(file)}\nexport const other = HostProcess.OtherSymbol;\n`;
    expect(edgeRatchet(withFile(file, injected)).regressions).toEqual([
      `effect-codex-app-server -> @t3tools/shared | ${file} -> ${specifier} | OtherSymbol (baseline 0, now 1): protocol must not depend on shared`,
    ]);
  });

  it.each([
    [
      "frontmatter",
      `---\nimport { x } from "../../../server/src/ws";\n---\n<p>{x}</p>`,
      ["app must not depend on app"],
    ],
    [
      "a script block",
      `---\n---\n<script>\n  import { x } from "@t3tools/web/x";\n</script>`,
      ["app must not depend on app"],
    ],
    [
      "an empty frontmatter, ignoring a later fence",
      `---\n---\n<p>import { x } from "t3/src/ws";</p>\n---\n`,
      [],
    ],
    [
      "valid imports, ignoring template text",
      `---\nimport { x } from "../lib/site";\nimport { y } from "@t3tools/contracts";\n---\n<p>import { z } from "t3/src/ws";</p>`,
      [],
    ],
  ] as const)("scans .astro %s", (_, content, reasons) => {
    expect([
      ...sourceImports(withFile("apps/marketing/src/pages/a.astro", content)).violations.values(),
    ]).toEqual(reasons);
  });

  it("fails a baselined file that borrows another symbol through the same specifier", () => {
    const file = "infra/relay/src/http/Api.test.ts";
    const specifier = "@t3tools/client-runtime/relay";
    const injected = `import { relayOther } from "${specifier}";\n${text(file)}`;
    expect(edgeRatchet(withFile(file, injected)).regressions).toEqual([
      `t3code-relay -> @t3tools/client-runtime | ${file} -> ${specifier} | relayOther (baseline 0, now 1): hosted must not depend on client-runtime`,
    ]);
  });

  it("finds a cycle that only a relative source import creates", () => {
    const { edges } = sourceImports(
      withFile("packages/contracts/src/a.ts", `import { x } from "../../shared/src/x.ts";`),
    );
    expect(findCycles(dependencyGraph(edges))).toContain(
      "@t3tools/contracts -> @t3tools/shared -> @t3tools/contracts",
    );
  });
});

describe("workspace", () => {
  it("keeps package and source dependency directions within the baseline", () => {
    const { regressions, stale } = edgeRatchet(sources);
    expect(regressions, RATCHET_HELP).toEqual([]);
    expect(stale, STALE_HELP).toEqual([]);
    const { used } = sourceImports(sources);
    expect(
      [...ALLOWED_CROSS_DOMAIN_IMPORTS].filter((entry) => !used.has(entry)),
      STALE_HELP,
    ).toEqual([]);
  });

  it("has no dependency cycles between workspace packages", () => {
    expect(findCycles(dependencyGraph(sourceImports(sources).edges))).toEqual([]);
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

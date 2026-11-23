import { describe, expect, it } from "vite-plus/test";
import {
  buildProjectInstructionsFromRules,
  classifyProjectRuleSource,
  parseRuleFrontmatter,
} from "./projectRulesImport.core.ts";

describe("parseRuleFrontmatter", () => {
  it("parses YAML frontmatter description, inline/block globs and alwaysApply", () => {
    const inlineResult = parseRuleFrontmatter(
      [
        "---",
        'description: "TypeScript and Effect rules"',
        'globs: ["packages/**/*.ts", "apps/**/*.ts"]',
        "alwaysApply: true",
        "---",
        "Use namespace imports for Effect.",
      ].join("\n"),
    );

    expect(inlineResult).toEqual({
      description: "TypeScript and Effect rules",
      globs: ["packages/**/*.ts", "apps/**/*.ts"],
      alwaysApply: true,
      hasFrontmatter: true,
      malformedFrontmatter: false,
      body: "Use namespace imports for Effect.",
    });

    const listResult = parseRuleFrontmatter(
      [
        "---",
        "description: Test conventions",
        "globs:",
        "  - '*.test.ts'",
        "  - '*.browser.test.tsx'",
        "alwaysApply: false",
        "---",
        "Never use wall-clock sleeps.",
      ].join("\r\n"),
    );

    expect(listResult.description).toBe("Test conventions");
    expect(listResult.globs).toEqual(["*.test.ts", "*.browser.test.tsx"]);
    expect(listResult.alwaysApply).toBe(false);
    expect(listResult.body).toBe("Never use wall-clock sleeps.");
  });

  it("flags unclosed or malformed frontmatter without losing content", () => {
    const unclosed = parseRuleFrontmatter("---\ndescription: broken\nNo closing fence");
    expect(unclosed.hasFrontmatter).toBe(false);
    expect(unclosed.malformedFrontmatter).toBe(true);
    expect(unclosed.body).toContain("No closing fence");

    const invalidBool = parseRuleFrontmatter("---\nalwaysApply: maybe\n---\nBody text");
    expect(invalidBool.hasFrontmatter).toBe(true);
    expect(invalidBool.malformedFrontmatter).toBe(true);
    expect(invalidBool.body).toBe("Body text");
  });
});

describe("classifyProjectRuleSource", () => {
  it.each([
    ["AGENTS.md", "agents_md"],
    ["CLAUDE.md", "claude_md"],
    [".gemini/GEMINI.md", "gemini"],
    [".cursorrules", "cursorrules"],
    [".cursor/rules/architecture.mdc", "cursor_mdc"],
    ["docs/CONVENTIONS.md", "other"],
  ])("classifies %s as %s", (path, expectedKind) => {
    expect(classifyProjectRuleSource(path).kind).toBe(expectedKind);
  });
});

describe("buildProjectInstructionsFromRules", () => {
  it("prioritizes AGENTS.md > CLAUDE.md > .gemini > .cursorrules > .cursor/rules/*.mdc and merges duplicates", () => {
    const result = buildProjectInstructionsFromRules([
      {
        path: ".cursor/rules/scoped.mdc",
        content: [
          "---",
          "description: Scoped UI rule",
          "globs: apps/web/**/*.tsx",
          "alwaysApply: false",
          "---",
          "Keep UI components dumb.",
        ].join("\n"),
      },
      {
        path: ".cursor/rules/global.mdc",
        content: [
          "---",
          "description: Global rule",
          "alwaysApply: true",
          "---",
          "Push I/O to the edges.",
        ].join("\n"),
      },
      {
        path: "CLAUDE.md",
        content: "# Architecture\n\nFunctional core, imperative shell.",
      },
      {
        path: "AGENTS.md",
        content: "# Architecture\n\nFunctional core, imperative shell.",
      },
      {
        path: ".gemini/styleguide.md",
        content:
          "# Architecture\n\nFunctional core, imperative shell.\n\nUse strict TypeScript types.",
      },
      {
        path: ".cursorrules",
        content: "   ",
      },
    ]);

    expect(result.rules.map((r) => r.primaryPath)).toEqual([
      "AGENTS.md",
      ".gemini/styleguide.md",
      ".cursor/rules/global.mdc",
      ".cursor/rules/scoped.mdc",
    ]);

    expect(result.rules[0]?.mergedPaths).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(result.rules[1]?.body).toBe("Use strict TypeScript types.");

    expect(result.instructionsMd).toContain("## AGENTS.md");
    expect(result.instructionsMd).toContain("> Merged from: `AGENTS.md`, `CLAUDE.md`");
    expect(result.instructionsMd).toContain("## .cursor/rules/global.mdc: Global rule");
    expect(result.instructionsMd).toContain("> Always apply: true");
    expect(result.instructionsMd).toContain("## .cursor/rules/scoped.mdc: Scoped UI rule");
    expect(result.instructionsMd).toContain(
      "> Applies to: `apps/web/**/*.tsx` (alwaysApply: false)",
    );

    expect(result.diagnostics.map((d) => `${d.path}:${d.reason}`)).toEqual([
      ".cursorrules:empty_content",
      "CLAUDE.md:duplicate_rule",
      ".gemini/styleguide.md:duplicate_section",
    ]);
  });
});

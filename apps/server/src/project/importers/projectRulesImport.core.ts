export interface ProjectRuleFileInput {
  readonly path: string;
  readonly content: string;
}

export interface RuleFrontmatter {
  readonly description: string | null;
  readonly globs: ReadonlyArray<string>;
  readonly alwaysApply: boolean | null;
  readonly hasFrontmatter: boolean;
  readonly malformedFrontmatter: boolean;
  readonly body: string;
}

export type ProjectRuleSourceKind =
  | "agents_md"
  | "claude_md"
  | "gemini"
  | "cursorrules"
  | "cursor_mdc"
  | "other";

export interface NormalizedProjectRule {
  readonly kind: ProjectRuleSourceKind;
  readonly primaryPath: string;
  readonly mergedPaths: ReadonlyArray<string>;
  readonly description: string | null;
  readonly globs: ReadonlyArray<string>;
  readonly alwaysApply: boolean | null;
  readonly body: string;
  readonly priority: number;
}

export type ProjectRuleDiagnosticReason =
  | "empty_content"
  | "duplicate_rule"
  | "duplicate_section"
  | "malformed_frontmatter";

export interface ProjectRuleDiagnostic {
  readonly path: string;
  readonly reason: ProjectRuleDiagnosticReason;
  readonly detail: string;
}

export interface BuildProjectRulesOptions {
  readonly deduplicateSections?: boolean | undefined;
}

export interface BuildProjectRulesResult {
  readonly instructionsMd: string;
  readonly rules: ReadonlyArray<NormalizedProjectRule>;
  readonly diagnostics: ReadonlyArray<ProjectRuleDiagnostic>;
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseGlobsScalar(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(",")
    .map((item) => unquoteYamlScalar(item))
    .filter((item) => item.length > 0);
}

export function parseRuleFrontmatter(rawContent: string): RuleFrontmatter {
  const normalized = rawContent.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return {
      description: null,
      globs: [],
      alwaysApply: null,
      hasFrontmatter: false,
      malformedFrontmatter: false,
      body: normalized.trim(),
    };
  }

  const lines = normalized.split("\n");
  let endLineIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const candidate = (lines[i] ?? "").trim();
    if (candidate === "---" || candidate === "...") {
      endLineIndex = i;
      break;
    }
  }

  if (endLineIndex === -1) {
    return {
      description: null,
      globs: [],
      alwaysApply: null,
      hasFrontmatter: false,
      malformedFrontmatter: true,
      body: normalized.trim(),
    };
  }

  const yamlLines = lines.slice(1, endLineIndex);
  const body = lines
    .slice(endLineIndex + 1)
    .join("\n")
    .trim();

  let description: string | null = null;
  let alwaysApply: boolean | null = null;
  const globs: string[] = [];
  let collectingGlobsList = false;
  let malformedFrontmatter = false;

  for (const rawLine of yamlLines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (collectingGlobsList && trimmed.startsWith("-")) {
      const item = unquoteYamlScalar(trimmed.slice(1));
      if (item.length > 0) globs.push(item);
      continue;
    }
    collectingGlobsList = false;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) {
      malformedFrontmatter = true;
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim().toLowerCase();
    const rawValue = trimmed.slice(colonIndex + 1).trim();

    if (key === "description") {
      const val = unquoteYamlScalar(rawValue);
      description = val.length > 0 ? val : null;
    } else if (key === "globs" || key === "glob") {
      if (rawValue.length === 0) {
        collectingGlobsList = true;
      } else {
        globs.push(...parseGlobsScalar(rawValue));
      }
    } else if (key === "alwaysapply" || key === "always_apply") {
      const val = unquoteYamlScalar(rawValue).toLowerCase();
      if (val === "true" || val === "yes" || val === "1") {
        alwaysApply = true;
      } else if (val === "false" || val === "no" || val === "0") {
        alwaysApply = false;
      } else if (val.length > 0) {
        malformedFrontmatter = true;
      }
    }
  }

  const uniqueGlobs = [...new Set(globs)];

  return {
    description,
    globs: uniqueGlobs,
    alwaysApply,
    hasFrontmatter: true,
    malformedFrontmatter,
    body,
  };
}

function normalizeRelativeRulePath(rawPath: string): string {
  return rawPath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

export function classifyProjectRuleSource(path: string): {
  readonly kind: ProjectRuleSourceKind;
  readonly basePriority: number;
  readonly depth: number;
} {
  const normalized = normalizeRelativeRulePath(path);
  const lower = normalized.toLowerCase();
  const segments = normalized.split("/").filter((s) => s.length > 0);
  const basename = (segments.at(-1) ?? "").toLowerCase();
  const depth = Math.max(0, segments.length - 1);

  if (basename === "agents.md" || basename === "agents.local.md") {
    return { kind: "agents_md", basePriority: 100, depth };
  }
  if (basename === "claude.md" || basename === "claude.local.md") {
    return { kind: "claude_md", basePriority: 200, depth };
  }
  if (basename === "gemini.md" || lower.startsWith(".gemini/") || lower.includes("/.gemini/")) {
    return { kind: "gemini", basePriority: 300, depth };
  }
  if (basename === ".cursorrules" || basename === "cursorrules") {
    return { kind: "cursorrules", basePriority: 400, depth };
  }
  if (
    lower.startsWith(".cursor/rules/") ||
    lower.includes("/.cursor/rules/") ||
    basename.endsWith(".mdc")
  ) {
    return { kind: "cursor_mdc", basePriority: 500, depth };
  }
  return { kind: "other", basePriority: 600, depth };
}

function normalizeTextForDedupe(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .toLowerCase();
}

function splitMarkdownSections(body: string): ReadonlyArray<string> {
  const blocks = body
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  return blocks;
}

function formatRuleHeaderMeta(rule: NormalizedProjectRule): string[] {
  const metaLines: string[] = [];
  if (rule.mergedPaths.length > 1) {
    metaLines.push(`> Merged from: ${rule.mergedPaths.map((p) => `\`${p}\``).join(", ")}`);
  }
  if (rule.globs.length > 0 && rule.alwaysApply !== null) {
    metaLines.push(
      `> Applies to: ${rule.globs.map((g) => `\`${g}\``).join(", ")} (alwaysApply: ${String(rule.alwaysApply)})`,
    );
  } else if (rule.globs.length > 0) {
    metaLines.push(`> Applies to: ${rule.globs.map((g) => `\`${g}\``).join(", ")}`);
  } else if (rule.alwaysApply !== null) {
    metaLines.push(`> Always apply: ${String(rule.alwaysApply)}`);
  }
  return metaLines;
}

export function buildProjectInstructionsFromRules(
  files: ReadonlyArray<ProjectRuleFileInput>,
  options?: BuildProjectRulesOptions,
): BuildProjectRulesResult {
  const deduplicateSections = options?.deduplicateSections ?? true;
  const diagnostics: ProjectRuleDiagnostic[] = [];

  interface CandidateRule {
    readonly kind: ProjectRuleSourceKind;
    readonly path: string;
    readonly description: string | null;
    readonly globs: ReadonlyArray<string>;
    readonly alwaysApply: boolean | null;
    readonly body: string;
    readonly priority: number;
  }

  const candidates: CandidateRule[] = [];

  for (const file of files) {
    const cleanPath = normalizeRelativeRulePath(file.path);
    const frontmatter = parseRuleFrontmatter(file.content);

    if (frontmatter.malformedFrontmatter) {
      diagnostics.push({
        path: cleanPath,
        reason: "malformed_frontmatter",
        detail: `Rule file ${cleanPath} contains malformed YAML frontmatter`,
      });
    }

    if (frontmatter.body.length === 0) {
      diagnostics.push({
        path: cleanPath,
        reason: "empty_content",
        detail: `Rule file ${cleanPath} has no markdown body`,
      });
      continue;
    }

    const classification = classifyProjectRuleSource(cleanPath);
    const scopeOffset =
      frontmatter.alwaysApply === true ? 0 : frontmatter.globs.length === 0 ? 10 : 20;
    const priority =
      classification.basePriority + Math.min(classification.depth, 9) * 3 + scopeOffset;

    candidates.push({
      kind: classification.kind,
      path: cleanPath,
      description: frontmatter.description,
      globs: frontmatter.globs,
      alwaysApply: frontmatter.alwaysApply,
      body: frontmatter.body,
      priority,
    });
  }

  const sortedCandidates = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.path.localeCompare(b.path),
  );

  const rules: NormalizedProjectRule[] = [];
  const rulesByFullBodyKey = new Map<string, number>();
  const seenSectionKeys = new Set<string>();

  for (const candidate of sortedCandidates) {
    const fullBodyKey = normalizeTextForDedupe(candidate.body);
    const existingIndex = rulesByFullBodyKey.get(fullBodyKey);

    if (existingIndex !== undefined) {
      const existing = rules[existingIndex];
      if (existing !== undefined) {
        const mergedPaths = existing.mergedPaths.includes(candidate.path)
          ? existing.mergedPaths
          : [...existing.mergedPaths, candidate.path];
        const mergedGlobs = [...new Set([...existing.globs, ...candidate.globs])];
        rules[existingIndex] = {
          ...existing,
          mergedPaths,
          description: existing.description ?? candidate.description,
          globs: mergedGlobs,
          alwaysApply: existing.alwaysApply ?? candidate.alwaysApply,
        };
        diagnostics.push({
          path: candidate.path,
          reason: "duplicate_rule",
          detail: `Merged duplicate rule content into ${existing.primaryPath}`,
        });
        continue;
      }
    }

    let finalBody = candidate.body;
    if (deduplicateSections) {
      const sections = splitMarkdownSections(candidate.body);
      const uniqueSections: string[] = [];
      let omittedSectionCount = 0;
      for (const section of sections) {
        const sectionKey = normalizeTextForDedupe(section);
        if (seenSectionKeys.has(sectionKey)) {
          omittedSectionCount += 1;
          continue;
        }
        seenSectionKeys.add(sectionKey);
        uniqueSections.push(section);
      }
      if (uniqueSections.length === 0) {
        diagnostics.push({
          path: candidate.path,
          reason: "duplicate_rule",
          detail: `All sections in ${candidate.path} were already covered by higher-priority rules`,
        });
        continue;
      }
      if (omittedSectionCount > 0) {
        diagnostics.push({
          path: candidate.path,
          reason: "duplicate_section",
          detail: `Omitted ${String(omittedSectionCount)} duplicate section(s) from ${candidate.path}`,
        });
      }
      finalBody = uniqueSections.join("\n\n");
    } else {
      for (const section of splitMarkdownSections(candidate.body)) {
        seenSectionKeys.add(normalizeTextForDedupe(section));
      }
    }

    const ruleIndex = rules.length;
    rulesByFullBodyKey.set(fullBodyKey, ruleIndex);
    rules.push({
      kind: candidate.kind,
      primaryPath: candidate.path,
      mergedPaths: [candidate.path],
      description: candidate.description,
      globs: candidate.globs,
      alwaysApply: candidate.alwaysApply,
      body: finalBody,
      priority: candidate.priority,
    });
  }

  const renderedBlocks = rules.map((rule) => {
    const titleSuffix = rule.description !== null ? `: ${rule.description}` : "";
    const heading = `## ${rule.primaryPath}${titleSuffix}`;
    const metaLines = formatRuleHeaderMeta(rule);
    return [heading, ...(metaLines.length > 0 ? [metaLines.join("\n")] : []), rule.body].join(
      "\n\n",
    );
  });

  return {
    instructionsMd: renderedBlocks.join("\n\n---\n\n"),
    rules,
    diagnostics,
  };
}

import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export type MetaProjectContextFormat = "hybrid" | "xml" | "markdown";

export interface MetaProjectContextRepositoryEntry {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string | null | undefined;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot?: string | null | undefined;
  readonly role: string;
  readonly description?: string | null | undefined;
}

export interface MetaProjectContextInput {
  readonly metaProjectId: string;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly instructionsMd: string;
  readonly repositories: ReadonlyArray<MetaProjectContextRepositoryEntry>;
  readonly activeRepository?:
    | {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
      }
    | null
    | undefined;
  readonly format?: MetaProjectContextFormat | undefined;
  readonly maxChars?: number | undefined;
}

export interface MetaProjectFormattedContext {
  readonly text: string;
  readonly charCount: number;
  readonly truncated: boolean;
  readonly omittedRepositoryCount: number;
  readonly instructionsTruncated: boolean;
}

export const DEFAULT_META_PROJECT_CONTEXT_MAX_CHARS = 16_000;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const isCurrentRepo = (
  repo: MetaProjectContextRepositoryEntry,
  active: MetaProjectContextInput["activeRepository"],
): boolean =>
  active != null &&
  repo.environmentId === active.environmentId &&
  repo.projectId === active.projectId;

const sortRepositoriesDeterministically = (
  repositories: ReadonlyArray<MetaProjectContextRepositoryEntry>,
  active: MetaProjectContextInput["activeRepository"],
): ReadonlyArray<MetaProjectContextRepositoryEntry> =>
  [...repositories].sort((left, right) => {
    const leftCurrent = isCurrentRepo(left, active) ? 0 : 1;
    const rightCurrent = isCurrentRepo(right, active) ? 0 : 1;
    if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;

    const roleDiff = left.role.localeCompare(right.role);
    if (roleDiff !== 0) return roleDiff;

    const titleDiff = left.title.localeCompare(right.title);
    if (titleDiff !== 0) return titleDiff;

    const envDiff = left.environmentId.localeCompare(right.environmentId);
    if (envDiff !== 0) return envDiff;

    return left.projectId.localeCompare(right.projectId);
  });

const formatRepoLineMarkdown = (
  repo: MetaProjectContextRepositoryEntry,
  current: boolean,
): string => {
  const envLabel = repo.environmentLabel?.trim() || repo.environmentId;
  const rootPart = repo.workspaceRoot ? ` \`${repo.workspaceRoot}\`` : "";
  const descPart = repo.description?.trim() ? ` - ${repo.description.trim()}` : "";
  const currentBadge = current ? " [current]" : "";
  return `- **[${repo.role}] ${repo.title}**${currentBadge} (env: \`${envLabel}\`, project: \`${repo.projectId}\`)${rootPart}${descPart}`;
};

const formatRepoXml = (repo: MetaProjectContextRepositoryEntry, current: boolean): string => {
  const envLabel = repo.environmentLabel?.trim() || repo.environmentId;
  const attrs = [
    `role="${escapeXml(repo.role)}"`,
    `title="${escapeXml(repo.title)}"`,
    `environment_id="${escapeXml(repo.environmentId)}"`,
    `environment_label="${escapeXml(envLabel)}"`,
    `project_id="${escapeXml(repo.projectId)}"`,
  ];
  if (repo.workspaceRoot) {
    attrs.push(`workspace_root="${escapeXml(repo.workspaceRoot)}"`);
  }
  if (current) {
    attrs.push(`current="true"`);
  }
  const desc = repo.description?.trim();
  return desc
    ? `    <repository ${attrs.join(" ")}>${escapeXml(desc)}</repository>`
    : `    <repository ${attrs.join(" ")} />`;
};

const buildEnvelope = (
  input: MetaProjectContextInput,
  format: MetaProjectContextFormat,
  includedRepos: ReadonlyArray<MetaProjectContextRepositoryEntry>,
  omittedRepoCount: number,
  instructionsText: string,
): string => {
  const description = input.description?.trim() ?? "";

  if (format === "xml") {
    const lines: string[] = [
      `<meta_project_context id="${escapeXml(input.metaProjectId)}" title="${escapeXml(input.title)}">`,
    ];
    if (description.length > 0) {
      lines.push(`  <description>${escapeXml(description)}</description>`);
    }
    lines.push("  <repositories>");
    for (const repo of includedRepos) {
      lines.push(formatRepoXml(repo, isCurrentRepo(repo, input.activeRepository)));
    }
    if (omittedRepoCount > 0) {
      lines.push(`    <omitted_repositories count="${omittedRepoCount}" />`);
    }
    lines.push("  </repositories>");
    if (instructionsText.length > 0) {
      lines.push("  <instructions>");
      lines.push(instructionsText);
      lines.push("  </instructions>");
    }
    lines.push("</meta_project_context>");
    return lines.join("\n");
  }

  const mdLines: string[] = [];
  if (format === "hybrid") {
    mdLines.push(
      `<meta_project_context id="${escapeXml(input.metaProjectId)}" title="${escapeXml(input.title)}">`,
    );
  }
  mdLines.push(`# Meta-Project: ${input.title}`);
  if (description.length > 0) {
    mdLines.push(description);
  }
  mdLines.push("");
  mdLines.push("## Repositories");
  if (includedRepos.length === 0 && omittedRepoCount === 0) {
    mdLines.push("- (none)");
  } else {
    for (const repo of includedRepos) {
      mdLines.push(formatRepoLineMarkdown(repo, isCurrentRepo(repo, input.activeRepository)));
    }
    if (omittedRepoCount > 0) {
      mdLines.push(`- ...and ${omittedRepoCount} more repositories omitted`);
    }
  }

  if (instructionsText.length > 0) {
    mdLines.push("");
    mdLines.push("## Instructions");
    mdLines.push(instructionsText);
  }

  if (format === "hybrid") {
    mdLines.push("</meta_project_context>");
  }

  return mdLines.join("\n");
};

const TRUNCATION_SUFFIX = "\n...[truncated]";

export function formatMetaProjectAgentContext(
  input: MetaProjectContextInput,
): MetaProjectFormattedContext {
  const format: MetaProjectContextFormat = input.format ?? "hybrid";
  const maxChars = Math.max(
    64,
    Math.trunc(input.maxChars ?? DEFAULT_META_PROJECT_CONTEXT_MAX_CHARS),
  );
  const sortedRepos = sortRepositoriesDeterministically(input.repositories, input.activeRepository);
  const cleanInstructions = input.instructionsMd.trim();

  const fullText = buildEnvelope(input, format, sortedRepos, 0, cleanInstructions);
  if (fullText.length <= maxChars) {
    return {
      text: fullText,
      charCount: fullText.length,
      truncated: false,
      omittedRepositoryCount: 0,
      instructionsTruncated: false,
    };
  }

  let includedRepos = sortedRepos;
  let omittedRepositoryCount = 0;
  let envelopeWithoutInstructions = buildEnvelope(input, format, includedRepos, 0, "");

  while (includedRepos.length > 0 && envelopeWithoutInstructions.length > maxChars) {
    includedRepos = includedRepos.slice(0, includedRepos.length - 1);
    omittedRepositoryCount = sortedRepos.length - includedRepos.length;
    envelopeWithoutInstructions = buildEnvelope(
      input,
      format,
      includedRepos,
      omittedRepositoryCount,
      "",
    );
  }

  if (envelopeWithoutInstructions.length >= maxChars) {
    const hardTruncated = envelopeWithoutInstructions.slice(0, maxChars);
    return {
      text: hardTruncated,
      charCount: hardTruncated.length,
      truncated: true,
      omittedRepositoryCount,
      instructionsTruncated: cleanInstructions.length > 0,
    };
  }

  if (cleanInstructions.length === 0) {
    return {
      text: envelopeWithoutInstructions,
      charCount: envelopeWithoutInstructions.length,
      truncated: omittedRepositoryCount > 0,
      omittedRepositoryCount,
      instructionsTruncated: false,
    };
  }

  const fullWithCurrentRepos = buildEnvelope(
    input,
    format,
    includedRepos,
    omittedRepositoryCount,
    cleanInstructions,
  );
  if (fullWithCurrentRepos.length <= maxChars) {
    return {
      text: fullWithCurrentRepos,
      charCount: fullWithCurrentRepos.length,
      truncated: omittedRepositoryCount > 0,
      omittedRepositoryCount,
      instructionsTruncated: false,
    };
  }

  const emptyInstructionsWithMarker = buildEnvelope(
    input,
    format,
    includedRepos,
    omittedRepositoryCount,
    TRUNCATION_SUFFIX.trimStart(),
  );
  if (emptyInstructionsWithMarker.length > maxChars) {
    return {
      text: envelopeWithoutInstructions,
      charCount: envelopeWithoutInstructions.length,
      truncated: true,
      omittedRepositoryCount,
      instructionsTruncated: true,
    };
  }

  const availableInstructionChars = Math.max(
    0,
    maxChars -
      buildEnvelope(input, format, includedRepos, omittedRepositoryCount, TRUNCATION_SUFFIX).length,
  );

  const slicedInstructions =
    availableInstructionChars > 0
      ? `${cleanInstructions.slice(0, availableInstructionChars)}${TRUNCATION_SUFFIX}`
      : TRUNCATION_SUFFIX.trimStart();

  const text = buildEnvelope(
    input,
    format,
    includedRepos,
    omittedRepositoryCount,
    slicedInstructions,
  );

  return {
    text,
    charCount: text.length,
    truncated: true,
    omittedRepositoryCount,
    instructionsTruncated: true,
  };
}

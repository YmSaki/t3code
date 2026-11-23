import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatMetaProjectAgentContext } from "./metaProjectContext.core.ts";

const envId = (id: string) => id as EnvironmentId;
const projId = (id: string) => id as ProjectId;

describe("metaProjectContext.core", () => {
  it("formats instructions and repository roster deterministically regardless of input order", () => {
    const repoFrontend = {
      environmentId: envId("env-local"),
      environmentLabel: "Laptop",
      projectId: projId("proj-web"),
      title: "Web UI",
      workspaceRoot: "/work/web",
      role: "frontend",
    };
    const repoBackend = {
      environmentId: envId("env-remote"),
      environmentLabel: "Build Server",
      projectId: projId("proj-api"),
      title: "API Server",
      workspaceRoot: "/srv/api",
      role: "backend",
    };

    const first = formatMetaProjectAgentContext({
      metaProjectId: "mp-1",
      title: "Acme Platform",
      description: "Multi-repo platform",
      instructionsMd: "Always update contracts before backend and frontend.",
      repositories: [repoFrontend, repoBackend],
      activeRepository: { environmentId: envId("env-local"), projectId: projId("proj-web") },
    });

    const second = formatMetaProjectAgentContext({
      metaProjectId: "mp-1",
      title: "Acme Platform",
      description: "Multi-repo platform",
      instructionsMd: "Always update contracts before backend and frontend.",
      repositories: [repoBackend, repoFrontend],
      activeRepository: { environmentId: envId("env-local"), projectId: projId("proj-web") },
    });

    expect(first.text).toBe(second.text);
    expect(first.truncated).toBe(false);
    expect(first.text).toContain('<meta_project_context id="mp-1" title="Acme Platform">');
    expect(first.text).toContain("**[frontend] Web UI** [current]");
    expect(first.text).toContain("**[backend] API Server**");
    expect(first.text).toContain("Always update contracts before backend and frontend.");
  });

  it("supports pure XML output and escapes special XML characters", () => {
    const result = formatMetaProjectAgentContext({
      metaProjectId: "mp-xml",
      title: 'R&D <Core> "Alpha"',
      instructionsMd: "Keep I/O at edges.",
      format: "xml",
      repositories: [
        {
          environmentId: envId("env-1"),
          projectId: projId("proj-1"),
          title: "Service & Worker",
          role: "backend",
          description: "Handles <jobs>",
        },
      ],
    });

    expect(result.text).toContain(
      '<meta_project_context id="mp-xml" title="R&amp;D &lt;Core&gt; &quot;Alpha&quot;">',
    );
    expect(result.text).toContain("Handles &lt;jobs&gt;</repository>");
  });

  it("truncates instructions and repositories cleanly within maxChars limit", () => {
    const longInstructions = "Rule line: enforce strict pure core boundaries.\n".repeat(40);
    const result = formatMetaProjectAgentContext({
      metaProjectId: "mp-budget",
      title: "Budgeted Project",
      instructionsMd: longInstructions,
      maxChars: 350,
      repositories: [
        {
          environmentId: envId("env-1"),
          projectId: projId("proj-1"),
          title: "Repo 1",
          role: "backend",
        },
      ],
    });

    expect(result.charCount).toBeLessThanOrEqual(350);
    expect(result.text.length).toBe(result.charCount);
    expect(result.truncated).toBe(true);
    expect(result.instructionsTruncated).toBe(true);
    expect(result.text).toContain("...[truncated]");
  });
});

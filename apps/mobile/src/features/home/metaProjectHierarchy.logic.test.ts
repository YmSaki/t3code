import type { MetaProjectTreeResult } from "@t3tools/client-runtime/state/metaProjects";
import { describe, expect, it } from "vite-plus/test";

import { mergeMetaProjectTrees, type MetaProjectTreeNode } from "./metaProjectHierarchy.logic";

const node = (
  metaProjectId: string,
  overrides: Partial<MetaProjectTreeNode> = {},
): MetaProjectTreeNode => ({
  metaProjectId,
  title: metaProjectId,
  description: null,
  pinned: false,
  archived: false,
  pmThreads: [],
  crossCuttingThreads: [],
  repositories: [],
  ...overrides,
});

const tree = (...metaProjects: MetaProjectTreeNode[]): MetaProjectTreeResult => ({
  metaProjects,
  uncategorizedRepositories: [],
});

describe("mergeMetaProjectTrees", () => {
  it("keeps a MetaProject seen from two machines once, pinned first, and skips archived", () => {
    const merged = mergeMetaProjectTrees([
      tree(node("beta"), node("alpha", { title: "Alpha" })),
      null,
      tree(
        node("alpha", { title: "Alpha from peer" }),
        node("zeta", { pinned: true }),
        node("old", { archived: true }),
      ),
    ]);
    expect(merged.map((item) => item.title)).toEqual(["zeta", "Alpha", "beta"]);
  });
});

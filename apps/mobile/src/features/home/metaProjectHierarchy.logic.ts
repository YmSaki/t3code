import type { MetaProjectTreeResult } from "@t3tools/client-runtime/state/metaProjects";

export type MetaProjectTreeNode = MetaProjectTreeResult["metaProjects"][number];
export type MetaProjectThreadNode = MetaProjectTreeNode["pmThreads"][number];

/**
 * One list of MetaProjects from every connected machine's tree. A server's tree already reaches
 * its peers' repositories, so a MetaProject seen from two machines is kept once.
 */
export function mergeMetaProjectTrees(
  trees: ReadonlyArray<MetaProjectTreeResult | null>,
): ReadonlyArray<MetaProjectTreeNode> {
  const byId = new Map<string, MetaProjectTreeNode>();
  for (const tree of trees) {
    for (const node of tree?.metaProjects ?? []) {
      if (!node.archived && !byId.has(node.metaProjectId)) byId.set(node.metaProjectId, node);
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) || left.title.localeCompare(right.title),
  );
}

export function countMetaProjectThreads(node: MetaProjectTreeNode): number {
  return (
    node.pmThreads.length +
    node.crossCuttingThreads.length +
    node.repositories.reduce((total, repository) => total + repository.threads.length, 0)
  );
}

/**
 * A thread row opens only when this device is connected to its machine and the thread still
 * exists there. The tree's own `online` badge is what the answering server reaches, not the phone.
 */
export function canOpenMetaProjectThread(
  thread: MetaProjectThreadNode,
  connectedEnvironmentIds: ReadonlyArray<string>,
): boolean {
  return !thread.missing && connectedEnvironmentIds.includes(thread.environmentId);
}

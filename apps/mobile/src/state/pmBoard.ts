import { useAtomValue } from "@effect/atom-react";
import { createPmBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/pmBoard";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadDetails } from "./threads";

export const pmBoardEnvironment = createPmBoardEnvironmentAtoms(connectionAtomRuntime);

export interface PmWorkerRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
}

// Workers may run on other machines than their PM, so each is read on its own environment.
const workerApprovals = Atom.family((key: string) => {
  const workers = JSON.parse(key) as ReadonlyArray<PmWorkerRef>;
  return Atom.make((get): ReadonlyArray<ChildThreadApproval> =>
    workers.flatMap((worker) => {
      const thread = { environmentId: worker.environmentId, threadId: worker.threadId };
      return (get(environmentThreadDetails.pendingRequestsAtom(thread))?.approvals ?? []).map(
        (approval) => ({ thread, title: worker.title, approval }),
      );
    }),
  ).pipe(Atom.withLabel(`mobile-pm-worker-approvals:${key}`));
});

/** Pending approvals of the given workers, in worker order. */
export function usePmWorkerApprovals(workers: ReadonlyArray<PmWorkerRef>) {
  return useAtomValue(workerApprovals(JSON.stringify(workers)));
}

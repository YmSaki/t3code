import type { PmBoardWorkerSummary, PmWorkerStatus, ThreadId } from "@t3tools/contracts";

export type PmWorkerBucket = "running" | "waiting" | "completed" | "failed";

export interface PmWorkerPendingQuestion {
  readonly workerThreadId: ThreadId;
  readonly title: string;
  readonly status: PmWorkerStatus;
  readonly questions: ReadonlyArray<string>;
}

export interface PmBoardGroupedWorkers {
  readonly running: ReadonlyArray<PmBoardWorkerSummary>;
  readonly waiting: ReadonlyArray<PmBoardWorkerSummary>;
  readonly completed: ReadonlyArray<PmBoardWorkerSummary>;
  readonly failed: ReadonlyArray<PmBoardWorkerSummary>;
}

export interface PmPendingInboxItem {
  readonly workerThreadId: ThreadId;
  readonly title: string;
  readonly status: PmWorkerStatus;
  readonly priority: number;
  readonly questions: ReadonlyArray<string>;
  readonly worker: PmBoardWorkerSummary | null;
}

export function classifyPmWorkerBucket(status: PmWorkerStatus): PmWorkerBucket {
  switch (status) {
    case "queued":
    case "running":
      return "running";
    case "waiting_approval":
    case "waiting_input":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
    case "interrupted":
    case "cancelled":
      return "failed";
  }
}

export function groupPmWorkers(
  workers: ReadonlyArray<PmBoardWorkerSummary>,
): PmBoardGroupedWorkers {
  const running: Array<PmBoardWorkerSummary> = [];
  const waiting: Array<PmBoardWorkerSummary> = [];
  const completed: Array<PmBoardWorkerSummary> = [];
  const failed: Array<PmBoardWorkerSummary> = [];
  for (const worker of workers) {
    const bucket = classifyPmWorkerBucket(worker.status);
    if (bucket === "running") running.push(worker);
    else if (bucket === "waiting") waiting.push(worker);
    else if (bucket === "completed") completed.push(worker);
    else failed.push(worker);
  }
  return { running, waiting, completed, failed };
}

export function formatPmWorkerElapsed(startedAt: string | null, nowMs: number): string | null {
  if (startedAt === null) return null;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

export function pmPendingPriority(status: PmWorkerStatus): number {
  if (status === "waiting_approval") return 0;
  if (status === "waiting_input") return 1;
  return 2;
}

export function buildPmPendingInbox(
  workers: ReadonlyArray<PmBoardWorkerSummary>,
  pendingQuestions: ReadonlyArray<PmWorkerPendingQuestion>,
): ReadonlyArray<PmPendingInboxItem> {
  const workersById = new Map<ThreadId, PmBoardWorkerSummary>();
  for (const worker of workers) {
    workersById.set(worker.threadId, worker);
  }
  const itemsByThread = new Map<ThreadId, PmPendingInboxItem>();
  for (const entry of pendingQuestions) {
    const worker = workersById.get(entry.workerThreadId) ?? null;
    itemsByThread.set(entry.workerThreadId, {
      workerThreadId: entry.workerThreadId,
      title: entry.title,
      status: entry.status,
      priority: pmPendingPriority(entry.status),
      questions: entry.questions,
      worker,
    });
  }
  for (const worker of workers) {
    if (
      (worker.status === "waiting_approval" || worker.status === "waiting_input") &&
      !itemsByThread.has(worker.threadId)
    ) {
      itemsByThread.set(worker.threadId, {
        workerThreadId: worker.threadId,
        title: worker.title,
        status: worker.status,
        priority: pmPendingPriority(worker.status),
        questions: [],
        worker,
      });
    }
  }
  return [...itemsByThread.values()].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.workerThreadId.localeCompare(right.workerThreadId);
  });
}

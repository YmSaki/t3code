import { AgentWorklogEntry, type WorklogFilter } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { forkParked } from "../serverActivation.ts";
import {
  make as makeWorklogService,
  WorklogService,
  type BackfillOrchestrationV2Options,
  type PeerWorklogFetcher,
  type WorklogServiceConfig,
} from "./WorklogService.ts";

/**
 * The peer MCP tool that answers with that environment's own entries. It must query with
 * `includePeers: false`, or two linked environments would ask each other forever.
 */
export const WORKLOG_PEER_TOOL = "worklog_query_local";

const PeerWorklogResult = Schema.Struct({ entries: Schema.Array(AgentWorklogEntry) });

/** Records every run as it reaches completion. Runs finished while no server ran need a backfill. */
export const runWorklogEventSubscription = Effect.fn("WorklogRuntimeWiring.runEventSubscription")(
  function* (options?: BackfillOrchestrationV2Options) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worklog = yield* WorklogService;
    yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "run.updated" && event.payload.completedAt !== null
        ? worklog.recordRuns([event.payload.id], options).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not record a completed run in the worklog", {
                runId: event.payload.id,
                cause,
              }),
            ),
          )
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("worklog run event stream failed", { cause })),
    );
  },
);

/** @public */
export const layerEventSubscription = (options?: BackfillOrchestrationV2Options) =>
  Layer.effectDiscard(forkParked(runWorklogEventSubscription(options)));

/** Asks each linked environment for its own entries; a peer that fails only drops its entries. */
const makePeerWorklogFetcher = Effect.fn("WorklogRuntimeWiring.makePeerWorklogFetcher")(
  function* () {
    const links = yield* PeerLinks.PeerLinks;
    const client = yield* PeerMcpClient.PeerMcpClient;
    const fetcher: PeerWorklogFetcher = Effect.fn("WorklogRuntimeWiring.peerFetcher")(function* (
      filter?: WorklogFilter,
    ) {
      if (!(yield* links.enabled)) return [];
      const peers = (yield* links.names.pipe(Effect.orElseSucceed(() => []))).filter(
        (peer) =>
          filter?.environmentIds === undefined ||
          filter.environmentIds.includes(peer.environmentId),
      );
      // A peer files its entries under its own id for itself, so it filters everything else here.
      const peerFilter = { ...filter, environmentIds: undefined };
      const perPeer = yield* Effect.forEach(
        peers,
        (peer) =>
          client
            .call({
              environmentId: peer.environmentId,
              tool: WORKLOG_PEER_TOOL,
              arguments: { filter: peerFilter },
              limits: { runtimeMode: "approval-required", interactionMode: "default" },
              success: PeerWorklogResult,
            })
            .pipe(
              Effect.map((result) =>
                result.entries.map((entry) => ({ ...entry, environmentId: peer.environmentId })),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Could not read a linked environment's worklog", {
                  environmentId: peer.environmentId,
                  cause,
                }).pipe(Effect.as([])),
              ),
            ),
        { concurrency: "unbounded" },
      );
      return perPeer.flat();
    });
    return fetcher;
  },
);

/** `WorklogService` whose queries and iCal feeds include linked environments' entries. */
export const layerWithPeers = (config?: Omit<WorklogServiceConfig, "peerFetcher">) =>
  Layer.effect(
    WorklogService,
    Effect.gen(function* () {
      const peerFetcher = yield* makePeerWorklogFetcher();
      return yield* makeWorklogService({ ...config, peerFetcher });
    }),
  );

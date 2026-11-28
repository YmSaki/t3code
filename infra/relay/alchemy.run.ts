// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Planetscale from "@alchemy.run/planetscale";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { MobileSourceMapsUploadCredentials, RelayObservability } from "./src/observability.ts";
import { isPreviewStage } from "./src/previewStages.ts";
import { PreviewTunnelSweep, PreviewTunnelSweepProvider } from "./src/previewTunnelSweep.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
      PreviewTunnelSweepProvider(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const db = yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const api = yield* RelayWorker.Api;
    if (isPreviewStage(stage)) {
      const { managedEndpointZoneName } = yield* RelayDeploymentConfig;
      yield* PreviewTunnelSweep("PreviewTunnelSweep", {
        stage,
        tunnelZoneName: managedEndpointZoneName,
        workerName: api.workerName,
      });
    }
    const baseOutputs = {
      databaseName: db.database.name,
      databaseBranchName: db.branch?.name ?? "main",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
    };
    if (Option.isNone(observability)) {
      yield* PublishClientConfig({ url: api.url });
      return baseOutputs;
    }

    const enabledObservability = observability.value;
    const mobileSourceMapsUploadCredentials = yield* MobileSourceMapsUploadCredentials;
    yield* PublishClientConfig({
      url: api.url,
      tracing: {
        mobileTracingUrl: enabledObservability.traces.otelTracesEndpoint,
        mobileTracingDataset: enabledObservability.traces.name,
        mobileTracingToken: enabledObservability.mobileIngestToken.token,
        clientTracingUrl: enabledObservability.traces.otelTracesEndpoint,
        clientTracingDataset: enabledObservability.traces.name,
        clientTracingToken: enabledObservability.clientIngestToken.token,
        tokenDigest: Output.map(
          Output.all(
            enabledObservability.mobileIngestToken.token,
            enabledObservability.clientIngestToken.token,
          ),
          tokenDigest,
        ),
      },
    });

    return {
      ...baseOutputs,
      mobileTracingUrl: enabledObservability.traces.otelTracesEndpoint,
      mobileTracingDataset: enabledObservability.traces.name,
      mobileTracingToken: enabledObservability.mobileIngestToken.token,
      clientTracingUrl: enabledObservability.traces.otelTracesEndpoint,
      clientTracingDataset: enabledObservability.traces.name,
      clientTracingToken: enabledObservability.clientIngestToken.token,
      mobileLogsDataset: enabledObservability.mobileLogs.name,
      mobileMetricsDataset: enabledObservability.mobileMetrics.name,
      mobileSourceMapsBucket: enabledObservability.mobileSourceMaps.bucketName,
      // The MOBILE_SOURCEMAPS_R2 secret for GitHub Actions and EAS Build.
      mobileSourceMapsUploadCredentials,
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);

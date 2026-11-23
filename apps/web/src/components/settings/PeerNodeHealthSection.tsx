import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, EnvironmentRole, PeerNodeHealthSnapshot } from "@t3tools/contracts";
import { evaluateNodeHealth } from "@t3tools/shared/nodeHealth.core";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { ActivityIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { m } from "~/i18n/messages";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsSection } from "./settingsLayout";

function roleBadgeLabel(role: EnvironmentRole, gt: ReturnType<typeof useGT>): string {
  switch (role) {
    case "hub":
      return gt("Hub");
    case "worker":
      return gt("Worker");
    case "standalone":
      return gt("Standalone");
  }
}

function healthBadgeVariant(
  grade: PeerNodeHealthSnapshot["grade"],
): "success" | "warning" | "error" {
  switch (grade) {
    case "healthy":
      return "success";
    case "degraded":
      return "warning";
    case "offline":
      return "error";
  }
}

function healthGradeLabel(
  grade: PeerNodeHealthSnapshot["grade"],
  gt: ReturnType<typeof useGT>,
): string {
  switch (grade) {
    case "healthy":
      return gt("Healthy");
    case "degraded":
      return gt("Degraded");
    case "offline":
      return gt("Offline");
  }
}

export function PeerNodeHealthSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const environmentRole = useEnvironmentSettings(
    environmentId,
    (settings) => settings.environmentRole,
  );
  const canProbe = useAtomValue(peerLinkEnvironment.probeHealth.permissionAtom(environmentId, {}));
  const healthQuery = useEnvironmentQuery(
    peerLinkEnvironment.health({ environmentId, input: {} }),
    resolve,
  );
  const probeHealth = useAtomCommand(peerLinkEnvironment.probeHealth, {
    reportFailure: false,
  });
  const [probingTarget, setProbingTarget] = useState<string | null>(null);

  const runProbe = async (targetId?: EnvironmentId) => {
    setProbingTarget(targetId ?? "all");
    const result = await probeHealth({
      environmentId,
      input: targetId !== undefined ? { environmentId: targetId } : {},
    });
    setProbingTarget(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Failed to probe linked nodes"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : m(msg("An error occurred.")),
        }),
      );
      return;
    }
    healthQuery.refresh();
  };

  const nodes = healthQuery.data?.nodes ?? [];
  const recommendedId = healthQuery.data?.recommendedEnvironmentId ?? null;

  return (
    <SettingsSection
      id="peer-node-health"
      title={gt("Node health")}
      icon={<ActivityIcon />}
      titleAction={
        <Badge variant={environmentRole === "hub" ? "info" : "secondary"} size="sm">
          <ServerIcon />
          {roleBadgeLabel(environmentRole, gt)}
        </Badge>
      }
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canProbe || probingTarget !== null}
          onClick={() => {
            void runProbe();
          }}
        >
          <RefreshCwIcon />
          {probingTarget === "all" ? gt("Probing...") : gt("Probe all")}
        </Button>
      }
    >
      {healthQuery.error !== null ? (
        <Alert variant="error">
          <AlertTitle>{gt("Could not load node health")}</AlertTitle>
          <AlertDescription>{healthQuery.error}</AlertDescription>
        </Alert>
      ) : null}

      {nodes.length === 0 && !healthQuery.isPending ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <div className={ITEM_ROW_INNER_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              {gt("No linked worker nodes are registered on this environment yet.")}
            </p>
          </div>
        </div>
      ) : null}

      {nodes.map((node) => {
        const assessment = evaluateNodeHealth({
          nodeId: node.environmentId,
          online: node.online,
          latencyMs: node.latencyMs,
          cpuUsagePercent: node.cpuUsagePercent ?? null,
          memoryUsagePercent: node.memoryUsagePercent ?? null,
          activeWorkers: node.activeWorkers,
          maxWorkers: node.maxWorkers,
        });
        const isRecommended = recommendedId === node.environmentId;
        const isProbingNode = probingTarget === node.environmentId;

        return (
          <div key={node.environmentId} className={ITEM_ROW_CLASSNAME}>
            <div className={ITEM_ROW_INNER_CLASSNAME}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{node.label}</span>
                  <Badge variant={healthBadgeVariant(assessment.grade)} size="sm">
                    {healthGradeLabel(assessment.grade, gt)}
                  </Badge>
                  {isRecommended ? (
                    <Badge variant="info" size="sm">
                      {gt("Recommended")}
                    </Badge>
                  ) : null}
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canProbe || probingTarget !== null}
                  onClick={() => {
                    void runProbe(node.environmentId);
                  }}
                >
                  <RefreshCwIcon />
                  {isProbingNode ? gt("Probing...") : gt("Probe")}
                </Button>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {node.latencyMs !== null ? (
                    <T>
                      Latency: <Var>{node.latencyMs}</Var> ms
                    </T>
                  ) : (
                    gt("Latency: unavailable")
                  )}
                </span>
                <span>
                  <T>
                    Workers: <Var>{node.activeWorkers}</Var>/<Var>{node.maxWorkers}</Var>
                  </T>
                </span>
                <span>
                  <T>
                    Score: <Var>{assessment.recommendedScore}</Var>
                  </T>
                </span>
              </div>

              {node.lastError ? (
                <p className="mt-1 text-xs text-destructive">{node.lastError}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </SettingsSection>
  );
}

import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type RepoMonitorActionKind,
  type RepoMonitorEventKind,
  type RepoMonitorEventRecord,
  type RepoMonitorFilter,
  type RepoMonitorRule,
  type RepoMonitorRuleUpsertInput,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export interface RepoMonitorPresetView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly eventKinds: ReadonlyArray<RepoMonitorEventKind>;
  readonly defaultFilter: RepoMonitorFilter;
  readonly actionKind: RepoMonitorActionKind;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly promptTemplate: string;
  readonly defaultCooldownSec: number;
  readonly defaultMaxTriggersPerHour: number;
}

export function createRepoMonitorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const rulesRevision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:repo-monitor:rules-rev:${environmentId}`)),
  );
  const eventsRevision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:repo-monitor:events-rev:${environmentId}`)),
  );
  const globalKillSwitch = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(false).pipe(
      Atom.withLabel(`environment-data:repo-monitor:global-kill-switch:${environmentId}`),
    ),
  );

  const bumpRules = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.update(rulesRevision(environmentId), (n) => n + 1);
      registry.update(eventsRevision(environmentId), (n) => n + 1);
    });

  const listRules = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:repo-monitor:list-rules",
    tag: WS_METHODS.repoMonitorListRules,
    staleTimeMs: 10_000,
    refreshTrigger: ({ environmentId }) => rulesRevision(environmentId),
  });

  const listEvents = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:repo-monitor:list-events",
    tag: WS_METHODS.repoMonitorListEvents,
    staleTimeMs: 5_000,
    refreshTrigger: ({ environmentId }) => eventsRevision(environmentId),
  });

  const presets = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:repo-monitor:presets",
    tag: WS_METHODS.repoMonitorListPresets,
    staleTimeMs: 60_000,
  });

  const upsertRule = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:repo-monitor:upsert-rule",
    tag: WS_METHODS.repoMonitorUpsertRule,
    onSuccess: ({ environmentId }, registry) => bumpRules(registry, environmentId),
  });

  const createRule = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:repo-monitor:create-rule",
    tag: WS_METHODS.repoMonitorUpsertRule,
    onSuccess: ({ environmentId }, registry) => bumpRules(registry, environmentId),
  });

  const updateRule = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:repo-monitor:update-rule",
    tag: WS_METHODS.repoMonitorUpsertRule,
    onSuccess: ({ environmentId }, registry) => bumpRules(registry, environmentId),
  });

  const deleteRule = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:repo-monitor:delete-rule",
    tag: WS_METHODS.repoMonitorDeleteRule,
    onSuccess: ({ environmentId }, registry) => bumpRules(registry, environmentId),
  });

  const dryRun = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:repo-monitor:dry-run",
    tag: WS_METHODS.repoMonitorDryRun,
  });

  const setGlobalKillSwitch = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:repo-monitor:set-global-kill-switch",
    tag: WS_METHODS.pmSetKillSwitch,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => {
        registry.set(globalKillSwitch(environmentId), input.active);
      }),
  });

  return {
    listRules,
    listEvents,
    presets,
    globalKillSwitch,
    upsertRule,
    createRule,
    updateRule,
    deleteRule,
    dryRun,
    setGlobalKillSwitch,
  };
}

export function parseRepoMonitorCommaList(
  raw: string,
): ReadonlyArray<typeof TrimmedNonEmptyString.Type> | undefined {
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => TrimmedNonEmptyString.make(item));
  return items.length > 0 ? items : undefined;
}

export function formatRepoMonitorCommaList(items?: ReadonlyArray<string>): string {
  return items && items.length > 0 ? items.join(", ") : "";
}

export function buildRepoMonitorRuleUpsertFromPreset(input: {
  readonly preset: RepoMonitorPresetView;
  readonly projectId: ProjectId;
  readonly environmentId?: EnvironmentId | undefined;
  readonly targetThreadId?: ThreadId | null | undefined;
}): RepoMonitorRuleUpsertInput {
  const { preset } = input;
  return {
    projectId: input.projectId,
    ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
    name: TrimmedNonEmptyString.make(preset.name),
    description: preset.description,
    enabled: true,
    eventKinds: [...preset.eventKinds],
    filter: { ...preset.defaultFilter },
    actionKind: preset.actionKind,
    ...(input.targetThreadId === undefined ? {} : { targetThreadId: input.targetThreadId }),
    runtimeMode: preset.defaultRuntimeMode,
    promptTemplate: TrimmedNonEmptyString.make(preset.promptTemplate),
    cooldownSec: NonNegativeInt.make(preset.defaultCooldownSec),
    maxTriggersPerHour: PositiveInt.make(preset.defaultMaxTriggersPerHour),
    presetId: TrimmedNonEmptyString.make(preset.id),
  };
}

export function buildRepoMonitorRuleToggleInput(
  rule: RepoMonitorRule,
  enabled: boolean,
): RepoMonitorRuleUpsertInput {
  return {
    id: rule.id,
    projectId: rule.projectId,
    ...(rule.environmentId === undefined ? {} : { environmentId: rule.environmentId }),
    name: rule.name,
    ...(rule.description === undefined ? {} : { description: rule.description }),
    enabled,
    eventKinds: rule.eventKinds,
    filter: rule.filter,
    actionKind: rule.actionKind,
    ...(rule.targetThreadId === undefined ? {} : { targetThreadId: rule.targetThreadId }),
    ...(rule.runtimeMode === undefined ? {} : { runtimeMode: rule.runtimeMode }),
    promptTemplate: rule.promptTemplate,
    cooldownSec: rule.cooldownSec,
    maxTriggersPerHour: rule.maxTriggersPerHour,
    ...(rule.presetId === undefined ? {} : { presetId: rule.presetId }),
  };
}

export function countTriggeredRepoMonitorEvents(
  events: ReadonlyArray<RepoMonitorEventRecord>,
): number {
  let count = 0;
  for (const event of events) {
    if (event.outcome === "triggered") {
      count += 1;
    }
  }
  return count;
}

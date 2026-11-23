import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type AgentSessionScanFilterOptions,
  createAgentSessionImportEnvironmentAtoms,
  filterImportProjectCandidates,
  toScanAllRpcInput,
} from "@t3tools/client-runtime/state/agentSessionImport";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { useContext } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useNowMinute } from "../hooks/useNowMinute";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

const agentSessionImportEnvironment =
  createAgentSessionImportEnvironmentAtoms(connectionAtomRuntime);

const NO_IMPORT_PERMISSION_ATOM = Atom.make(false).pipe(
  Atom.withLabel("agent-session-import:permission:none"),
);

export function useUnifiedAgentSessionScan(
  environmentId: EnvironmentId | null,
  options: AgentSessionScanFilterOptions = {},
) {
  const nowMinute = useNowMinute();
  const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe(nowMinute));
  const rpcInput = toScanAllRpcInput({ sources: options.sources });

  const query = useEnvironmentQuery(
    environmentId !== null
      ? agentSessionImportEnvironment.scanAll({ environmentId, input: rpcInput })
      : null,
  );

  const rawCandidates = query.data?.candidates ?? [];
  const candidates = filterImportProjectCandidates(rawCandidates, {
    ...options,
    nowMs,
  });

  return {
    ...query,
    candidates,
    allCandidates: rawCandidates,
  };
}

export function useUnifiedAgentSessionImportPermission(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId !== null
      ? agentSessionImportEnvironment.importSelected.permissionAtom(environmentId)
      : NO_IMPORT_PERMISSION_ATOM,
  );
}

export function useUnifiedAgentSessionImport() {
  return useAtomCommand(agentSessionImportEnvironment.importSelected, {
    label: "Import local agent sessions",
  });
}

export function useRefreshUnifiedAgentSessionScan() {
  const registry = useContext(RegistryContext);
  return (environmentId: EnvironmentId) => {
    Effect.runSync(agentSessionImportEnvironment.refreshScan(registry, environmentId));
  };
}

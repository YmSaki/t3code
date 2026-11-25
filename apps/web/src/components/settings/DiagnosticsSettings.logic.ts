import {
  ResourceMonitorProviderHint,
  type ServerProcessDiagnosticsEntry,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";

const PROVIDER_SUFFIXES = ResourceMonitorProviderHint.literals.map((provider) => ` [${provider}]`);

export function formatDiagnosticsDuration(value: number): string {
  const milliseconds = Math.round(value);
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")} s`;
}

export function formatProcessName(command: string): string {
  const suffix = PROVIDER_SUFFIXES.find((label) => command.endsWith(label));
  return suffix ? command.slice(0, -suffix.length) : command;
}

export function formatProcessType(
  process: Pick<ServerProcessDiagnosticsEntry, "command" | "depth">,
  resolve: MessageResolver,
): string {
  if (process.depth > 0) return resolve(msg("Subprocess"));
  if (PROVIDER_SUFFIXES.some((suffix) => process.command.endsWith(suffix)))
    return resolve(msg("Agent", { $context: "process type" }));
  return resolve(msg("Process", { $context: "process type" }));
}

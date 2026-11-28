import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomeVariable } from "./pathExpansion.ts";

// T3's own configuration must not reach provider children; T3 sets the few it needs (such as
// T3CODE_THREAD_ID) after this merge.
const isInternalEnvironmentName = (name: string) => {
  const upper = name.toUpperCase();
  return upper.startsWith("T3CODE_") || upper.startsWith("VITE_");
};

const withoutInternalEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const names = Object.keys(env);
  if (!names.some(isInternalEnvironmentName)) return env;
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !isInternalEnvironmentName(name)),
  );
};

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const inherited = withoutInternalEnvironment(baseEnv);
  if (!environment || environment.length === 0) {
    return inherited;
  }

  const home = yield* HostProcess.HomeDirectory;
  const windows = (yield* HostProcess.Platform) === "win32";
  const next: NodeJS.ProcessEnv = { ...inherited };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const existing of Object.keys(next)) {
        if (existing.toUpperCase() === name) delete next[existing];
      }
    }
    next[name] = expandHomeVariable(name, variable.value, home);
  }
  return next;
});

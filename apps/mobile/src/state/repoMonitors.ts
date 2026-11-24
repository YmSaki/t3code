import { createRepoMonitorEnvironmentAtoms } from "@t3tools/client-runtime/state/repoMonitors";

import { connectionAtomRuntime } from "../connection/runtime";

export const repoMonitorEnvironment = createRepoMonitorEnvironmentAtoms(connectionAtomRuntime);

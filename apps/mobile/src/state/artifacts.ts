import { createArtifactEnvironmentAtoms } from "@t3tools/client-runtime/state/artifacts";

import { connectionAtomRuntime } from "../connection/runtime";

export const artifactEnvironment = createArtifactEnvironmentAtoms(connectionAtomRuntime);

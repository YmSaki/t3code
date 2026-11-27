const upstreamOwner = "pingdotgg";
const upstreamProjectId = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const upstreamAppleTeamId = "ARK85ZXQ4Z";
const upstreamClerkDomain = "clerk.t3.codes";
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function mobileReleaseConfig(env: Readonly<Record<string, string | undefined>>) {
  const distribution = env.T3CODE_MOBILE_DISTRIBUTION?.trim() || "upstream";
  const updates = env.T3CODE_MOBILE_UPDATES_ENABLED;
  if (distribution === "upstream") {
    return {
      fork: false,
      owner: upstreamOwner,
      projectId: upstreamProjectId,
      appleTeamId: upstreamAppleTeamId,
      clerkDomain: upstreamClerkDomain,
      updatesEnabled: updates !== "0",
    };
  }
  if (distribution !== "fork") {
    throw new Error("T3CODE_MOBILE_DISTRIBUTION must be upstream or fork.");
  }

  const owner = env.T3CODE_MOBILE_EAS_OWNER?.trim() || undefined;
  const projectId = env.T3CODE_MOBILE_EAS_PROJECT_ID?.trim().toLowerCase() || undefined;
  if (Boolean(owner) !== Boolean(projectId)) {
    throw new Error("Set both T3CODE_MOBILE_EAS_OWNER and T3CODE_MOBILE_EAS_PROJECT_ID.");
  }
  if (owner?.toLowerCase() === upstreamOwner || projectId === upstreamProjectId) {
    throw new Error("The fork must use its own Expo account and EAS project.");
  }
  if (projectId && !uuidPattern.test(projectId)) {
    throw new Error("T3CODE_MOBILE_EAS_PROJECT_ID must be a UUID.");
  }
  if (updates === "1" && !projectId) {
    throw new Error("Fork OTA updates require a fork EAS project.");
  }

  const appleTeamId = env.T3CODE_MOBILE_APPLE_TEAM_ID?.trim() || undefined;
  if (appleTeamId && (!/^[A-Z0-9]{10}$/.test(appleTeamId) || appleTeamId === upstreamAppleTeamId)) {
    throw new Error("T3CODE_MOBILE_APPLE_TEAM_ID must be the fork's 10-character Apple team ID.");
  }
  const clerkDomain = env.T3CODE_MOBILE_CLERK_DOMAIN?.trim().toLowerCase() || undefined;
  if (
    clerkDomain &&
    (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(clerkDomain) || clerkDomain === upstreamClerkDomain)
  ) {
    throw new Error("T3CODE_MOBILE_CLERK_DOMAIN must be a fork-owned hostname.");
  }
  return {
    fork: true,
    owner,
    projectId,
    appleTeamId,
    clerkDomain,
    updatesEnabled: Boolean(projectId) && updates !== "0",
  };
}

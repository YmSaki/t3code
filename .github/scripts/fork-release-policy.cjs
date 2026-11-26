const { assertCommitOnDefaultBranch, assertReleaseSource } = require("./check-nightly-release.cjs");

const FORK_REPOSITORY = "YmSaki/t3codeJP";
const INITIAL_STABLE_VERSION = "1.0.0";
const MINIMUM_NIGHTLY_GAP_MS = 6 * 60 * 60 * 1000;
const CORE_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/;
const NIGHTLY_TAG = /^v([^-]+)-nightly\.\d{8}\.[1-9]\d*$/;
const REQUIRED_SIGNING_CONFIGURATION = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_TEAM_ID",
  "MACOS_PROVISIONING_PROFILE",
  "CLERK_PASSKEY_RP_DOMAINS",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
];
const RELEASES_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      releases(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { tagName isDraft isPrerelease publishedAt }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function releaseChannel(eventName, dispatchChannel) {
  if (eventName === "schedule") return "nightly";
  if (eventName === "push") return "stable";
  if (
    eventName === "workflow_dispatch" &&
    ["preview", "stable", "nightly"].includes(dispatchChannel)
  ) {
    return dispatchChannel;
  }
  throw new Error("Unsupported fork release event or channel.");
}

function assertForkReleaseSigningConfiguration(env) {
  const missing = REQUIRED_SIGNING_CONFIGURATION.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing fork release signing configuration: ${missing.join(", ")}.`);
  }
}

function coreVersion(version) {
  if (!CORE_VERSION.test(version)) return undefined;
  const parts = version.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? { version, parts } : undefined;
}

function isNewerVersion(left, right) {
  const index = left.parts.findIndex((part, index) => part !== right.parts[index]);
  return index !== -1 && left.parts[index] > right.parts[index];
}

function requireStableVersion(version) {
  const parsed = coreVersion(version);
  if (!parsed) throw new Error("A fork release must use a plain Stable tag of the form vX.Y.Z.");
  if (parsed.parts[0] < 1) throw new Error("A fork Stable version must be 1.0.0 or newer.");
  return parsed;
}

function nextStableVersion(latestStable) {
  if (!latestStable) return INITIAL_STABLE_VERSION;
  const [major, minor, patch] = latestStable.parts;
  if (patch === Number.MAX_SAFE_INTEGER) {
    throw new Error("The next Stable version cannot be represented. Choose a new Stable version.");
  }
  return `${major}.${minor}.${patch + 1}`;
}

async function readForkReleaseHistory(github, repositoryName) {
  let latestStable;
  let latestNightly;
  let cursor = null;
  do {
    const { repository } = await github.graphql(RELEASES_QUERY, { ...repositoryName, cursor });
    const { nodes, pageInfo } = repository.releases;
    for (const release of nodes) {
      if (release.isDraft || !release.publishedAt) continue;
      const publishedAt = Date.parse(release.publishedAt);
      if (!Number.isFinite(publishedAt)) continue;

      if (release.isPrerelease) {
        const version = NIGHTLY_TAG.exec(release.tagName)?.[1];
        const core = version === undefined ? undefined : coreVersion(version);
        if (
          core &&
          core.parts[0] >= 1 &&
          (!latestNightly || publishedAt > latestNightly.publishedAt)
        ) {
          latestNightly = { tag: release.tagName, version, publishedAt };
        }
      } else if (release.tagName.startsWith("v")) {
        const core = coreVersion(release.tagName.slice(1));
        if (core && core.parts[0] >= 1 && (!latestStable || isNewerVersion(core, latestStable))) {
          latestStable = core;
        }
      }
    }
    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);
  return { latestStable, latestNightly };
}

async function nightlySkipReason({ github, context, latestNightly, now }) {
  if (!latestNightly) return undefined;
  if (now - latestNightly.publishedAt < MINIMUM_NIGHTLY_GAP_MS) {
    return `Nightly ${latestNightly.tag} was published less than six hours ago.`;
  }
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${latestNightly.tag}...${context.sha}`,
    per_page: 1,
  });
  if (data.status !== "ahead") {
    return `Candidate commit is ${data.status} relative to Nightly ${latestNightly.tag}.`;
  }
}

async function stampPrerelease({ github, context, channel, baseVersion }) {
  const { data } = await github.rest.actions.getWorkflowRun({
    ...context.repo,
    run_id: context.runId,
  });
  const started = new Date(data.created_at);
  if (
    !Number.isFinite(started.getTime()) ||
    !Number.isSafeInteger(context.runNumber) ||
    context.runNumber < 1
  ) {
    throw new Error("GitHub did not provide a valid release run date and number.");
  }
  const date = started.toISOString().slice(0, 10).replaceAll("-", "");
  return `${baseVersion}-${channel}.${date}.${context.runNumber}`;
}

async function planForkRelease({
  github,
  context,
  dispatchChannel = "preview",
  dispatchVersion = "",
  pauseNightly = false,
  publishEnabled = false,
  validateSigning = false,
  distribution = "all",
  now = Date.now(),
}) {
  const slug = `${context.repo.owner}/${context.repo.repo}`;
  if (slug.toLowerCase() !== FORK_REPOSITORY.toLowerCase()) {
    throw new Error(`Fork release preflight only runs in ${FORK_REPOSITORY}.`);
  }

  if (!["all", "cli"].includes(distribution)) throw new Error("Invalid release distribution.");
  const cliOnly = distribution === "cli";
  if (cliOnly && (context.eventName !== "workflow_dispatch" || validateSigning)) {
    throw new Error(
      "CLI-only builds require a manual distribution run without signing validation.",
    );
  }

  const channel = releaseChannel(context.eventName, dispatchChannel);
  const scheduled = context.eventName === "schedule";
  if (validateSigning && (context.eventName !== "workflow_dispatch" || channel !== "nightly")) {
    throw new Error("Signing validation requires a manual Nightly run from main.");
  }
  if (scheduled && pauseNightly) {
    return { shouldBuild: false, channel, reason: "Scheduled Nightly is paused." };
  }
  if (channel !== "preview" && context.payload.repository?.default_branch !== "main") {
    throw new Error("The fork default branch must be main for Stable and Nightly releases.");
  }
  const versionOverride = dispatchVersion.trim();
  if (versionOverride && (context.eventName !== "workflow_dispatch" || channel !== "stable")) {
    throw new Error("A version override is allowed only for a manual Stable promotion.");
  }
  const pushedTag = context.eventName === "push" && context.ref.startsWith("refs/tags/v");
  if (context.eventName === "push" && !pushedTag) {
    throw new Error("A fork release must use a plain Stable tag of the form vX.Y.Z.");
  }
  const requestedStable = pushedTag
    ? requireStableVersion(context.ref.slice("refs/tags/v".length))
    : versionOverride
      ? requireStableVersion(versionOverride.replace(/^v/, ""))
      : undefined;

  await assertReleaseSource({ github, context, releaseChannel: channel });
  const { latestStable, latestNightly } = await readForkReleaseHistory(github, context.repo);
  if (scheduled) {
    const reason = await nightlySkipReason({ github, context, latestNightly, now });
    if (reason) return { shouldBuild: false, channel, reason };
  }

  let ref = context.sha;
  let version;
  if (channel === "stable") {
    let target = requestedStable;
    if (!pushedTag) {
      if (!latestNightly) throw new Error("No published fork Nightly is available to promote.");
      target ??= requireStableVersion(latestNightly.version);
      const { data } = await github.rest.repos.getCommit({
        ...context.repo,
        ref: latestNightly.tag,
      });
      ref = data.sha;
      await assertCommitOnDefaultBranch({ github, context, sha: ref });
    }
    if (latestStable && !isNewerVersion(target, latestStable)) {
      throw new Error(
        `A fork Stable version must be newer than published Stable v${latestStable.version}.`,
      );
    }
    version = target.version;
  } else {
    version = await stampPrerelease({
      github,
      context,
      channel,
      baseVersion: nextStableVersion(latestStable),
    });
  }

  const tag = `v${version}`;
  const track = channel === "nightly" ? "Nightly" : "Preview";
  const draft = channel === "preview";
  const publish = publishEnabled && !validateSigning;
  return {
    shouldBuild: true,
    distribution,
    channel,
    ref,
    version,
    tag,
    name:
      channel === "stable"
        ? `T3CodeJP ${cliOnly ? "CLI " : ""}${tag}`
        : `T3CodeJP ${cliOnly ? "CLI " : ""}${track} ${version} (${ref.slice(0, 12)})`,
    draft,
    publish,
    requireSigning: validateSigning || (publish && !draft && !cliOnly),
    isPrerelease: channel !== "stable",
    makeLatest: channel === "stable" && !cliOnly,
    hasUpdateFeed: channel !== "preview" && !cliOnly,
  };
}

module.exports = { assertForkReleaseSigningConfiguration, planForkRelease };

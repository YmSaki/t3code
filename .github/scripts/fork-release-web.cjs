const { hostedAppRoutingFromEnv } = require("../../packages/shared/src/hostedApp.ts");
const { assertCommitOnDefaultBranch } = require("./check-nightly-release.cjs");
const { forkReleaseCliAssets } = require("./fork-release-assets.cjs");

const RELEASE_TAG = /^v([1-9]\d*(?:\.(?:0|[1-9]\d*)){2}(-nightly\.\d{8}\.[1-9]\d*)?)$/;

function resolveForkWebRouting(env) {
  const routing = hostedAppRoutingFromEnv(env);
  if (!routing) return null;
  const routerDomain = new URL(routing.router).hostname;
  const latestDomain = new URL(routing.stable).hostname;
  const nightlyDomain = new URL(routing.nightly).hostname;
  for (const host of [routerDomain, latestDomain, nightlyDomain]) {
    if (host === "t3.codes" || host.endsWith(".t3.codes") || host.endsWith(".")) {
      throw new Error(`Use a fork-owned hostname for hosted Web: ${host}.`);
    }
  }
  return { routerUrl: routing.router, latestDomain, nightlyDomain };
}

async function planForkWebRelease({ github, context, tag, expectedSha, env }) {
  const releaseTag = RELEASE_TAG.exec(tag.trim());
  if (!releaseTag) throw new Error("Select a published Stable or Nightly release tag.");
  const [exactTag, version, nightlySuffix] = releaseTag;
  const channel = nightlySuffix ? "nightly" : "latest";
  const routing = resolveForkWebRouting(env);
  if (!routing) throw new Error("Set the three fork hosted Web repository variables.");

  const { data: release } = await github.rest.repos.getReleaseByTag({
    ...context.repo,
    tag: exactTag,
  });
  if (
    release.tag_name !== exactTag ||
    release.draft ||
    !release.published_at ||
    release.prerelease !== Boolean(nightlySuffix)
  ) {
    throw new Error(
      `${exactTag} is not a published ${nightlySuffix ? "Nightly" : "Stable"} release.`,
    );
  }
  const uploadedAssets = new Set(
    release.assets
      .filter((asset) => asset.state === "uploaded" && asset.size > 0)
      .map((asset) => asset.name),
  );
  const missingAssets = forkReleaseCliAssets(version).filter((name) => !uploadedAssets.has(name));
  if (missingAssets.length > 0) {
    throw new Error(`${exactTag} is missing CLI release assets: ${missingAssets.join(", ")}.`);
  }

  const { data: commit } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: `tags/${exactTag}`,
  });
  if (expectedSha && commit.sha !== expectedSha) {
    throw new Error(`${exactTag} does not match the source commit used to build the CLI archives.`);
  }
  await assertCommitOnDefaultBranch({ github, context, sha: commit.sha });
  return { sha: commit.sha, version, channel, ...routing };
}

module.exports = { planForkWebRelease, resolveForkWebRouting };

// Known violations on main, ratcheted by architecture-boundaries.test.ts (docs/internals/review.md,
// "Technical debt baseline policy"). Never add an entry for new code; delete entries once fixed.
// Entries without `tracking` still need a tracking item.

type Tracking = ReadonlyArray<`#${number}`>;

// Adopted design rather than debt: the pairs a cross-domain rule would otherwise flag.
export const ALLOWED_CROSS_DOMAIN_EDGES: ReadonlySet<string> = new Set([
  // source-control-core owns the IssueTracker interface that issue trackers implement.
  "@t3tools/issue-tracker-linear -> @t3tools/source-control-core",
]);

const GENERIC_PROVIDER_HELPER =
  "Borrows a generic helper from provider-core; unrelated domains must not depend on one another for generic helpers (overview.md). Move the helper to its own owner.";

export const PACKAGE_EDGE_BASELINE: ReadonlyArray<{
  readonly edge: string;
  readonly imports: ReadonlyArray<string>;
  readonly reason: string;
  readonly tracking?: Tracking;
}> = [
  {
    edge: "effect-codex-app-server -> @t3tools/shared",
    imports: [
      "packages/effect-codex-app-server/src/_internal/stdio.test.ts -> @t3tools/shared/HostProcess",
      "packages/effect-codex-app-server/src/_internal/stdio.ts -> @t3tools/shared/HostProcess",
    ],
    reason: "Standalone protocol libraries must have zero product package dependencies.",
  },
  {
    edge: "t3code-relay -> @t3tools/client-runtime",
    imports: [
      "infra/relay/src/environments/EnvironmentConnector.ts -> @t3tools/client-runtime/rpc",
      "infra/relay/src/http/Api.test.ts -> @t3tools/client-runtime/relay",
    ],
    reason:
      "A hosted service depends on the client runtime; the shared wire pieces belong to contracts or shared.",
  },
  {
    edge: "@t3tools/secret-provider-onepassword -> @t3tools/provider-core",
    imports: [
      "packages/secret-provider-onepassword/src/server/driver.ts -> @t3tools/provider-core/server/snapshotProbe",
    ],
    reason: GENERIC_PROVIDER_HELPER,
  },
  {
    edge: "@t3tools/source-control-bitbucket -> @t3tools/provider-core",
    imports: [
      "packages/source-control-bitbucket/src/server/BitbucketApi.ts -> @t3tools/provider-core/server/collectStreamText",
    ],
    reason: GENERIC_PROVIDER_HELPER,
  },
  {
    edge: "@t3tools/source-control-cursor-origin -> @t3tools/provider-core",
    imports: [
      "packages/source-control-cursor-origin/src/server/OriginCli.ts -> @t3tools/provider-core/server/collectStreamText",
    ],
    reason: GENERIC_PROVIDER_HELPER,
  },
  {
    edge: "@t3tools/source-control-forgejo -> @t3tools/provider-core",
    imports: [
      "packages/source-control-forgejo/src/server/ForgejoCli.ts -> @t3tools/provider-core/server/collectStreamText",
    ],
    reason: GENERIC_PROVIDER_HELPER,
  },
  {
    edge: "@t3tools/source-control-gitcafe -> @t3tools/provider-core",
    imports: [
      "packages/source-control-gitcafe/src/server/GitCafePullRequestProvider.ts -> @t3tools/provider-core/server/randomUuid",
      "packages/source-control-gitcafe/src/server/GitCafeSourceControlProvider.ts -> @t3tools/provider-core/server/randomUuid",
    ],
    reason: GENERIC_PROVIDER_HELPER,
  },
  {
    edge: "@t3tools/source-control-github -> @t3tools/provider-core",
    imports: [
      "packages/source-control-github/src/server/GitHubRest.ts -> @t3tools/provider-core/server/collectStreamText",
      "packages/source-control-github/src/server/gitHubGraphQlClient.ts -> @t3tools/provider-core/server/collectStreamText",
    ],
    reason: GENERIC_PROVIDER_HELPER,
  },
];

const MARKETING = "Upstream marketing site content; the fork has no site of its own yet.";
const HOSTED = "Upstream hosted web app, relay, or sign-in endpoint (fork isolation).";
const REPOSITORY = "Points at the upstream repository, its docs, or its releases (fork isolation).";
const BRAND = "Upstream domain used as product identity text or a default identifier.";
const FIXTURE = "Mock agent output that only tests read.";

export const UPSTREAM_REFERENCE_BASELINE: ReadonlyArray<{
  readonly file: string;
  readonly refs: Readonly<Record<string, number>>;
  readonly reason: string;
  readonly tracking?: Tracking;
}> = [
  { file: "apps/marketing/astro.config.mjs", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/public/robots.txt", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/de.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/en.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/es.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/fr.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/ja.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/ko.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/pt-BR.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/ru.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/i18n/zh.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  {
    file: "apps/marketing/src/lib/releases.ts",
    refs: { "pingdotgg/t3code": 1 },
    reason: MARKETING,
  },
  { file: "apps/marketing/src/lib/seo.ts", refs: { "t3.codes": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/lib/site.ts", refs: { "pingdotgg/t3code": 1 }, reason: MARKETING },
  { file: "apps/marketing/src/lib/stats.ts", refs: { "pingdotgg/t3code": 1 }, reason: MARKETING },
  {
    file: "apps/marketing/src/pages/.well-known/security.txt.ts",
    refs: { "t3.codes": 1 },
    reason: MARKETING,
  },
  { file: "apps/marketing/src/pages/404.astro", refs: { "t3.codes": 2 }, reason: MARKETING },
  { file: "apps/marketing/src/pages/95.astro", refs: { "t3.codes": 1 }, reason: MARKETING },
  {
    file: "apps/marketing/src/pages/[...locale]/download.astro",
    refs: { "t3.codes": 4 },
    reason: MARKETING,
  },
  {
    file: "apps/marketing/src/pages/[...locale]/index.astro",
    refs: { "pingdotgg/t3code": 4 },
    reason: MARKETING,
  },
  {
    file: "apps/marketing/src/pages/llms.txt.ts",
    refs: { "t3.codes": 1, "app.t3.codes": 2 },
    reason: MARKETING,
  },
  {
    file: "apps/marketing/src/pages/privacy-policy.astro",
    refs: { "app.t3.codes": 3, "t3.codes": 4 },
    reason: MARKETING,
  },
  {
    file: "apps/marketing/src/pages/security-policy.astro",
    refs: { "app.t3.codes": 2, "t3.codes": 6 },
    reason: MARKETING,
  },
  {
    file: "apps/marketing/src/pages/terms-of-service.astro",
    refs: { "app.t3.codes": 3, "t3.codes": 4 },
    reason: MARKETING,
  },
  { file: "apps/marketing/vercel.ts", refs: { "app.t3.codes": 1 }, reason: MARKETING },
  {
    file: "apps/mobile/app.config.ts",
    refs: { "clerk.t3.codes": 3, "app.t3.codes": 2 },
    reason: HOSTED,
    tracking: ["#49", "#77"],
  },
  {
    file: "apps/mobile/modules/t3-composer-editor/android/src/main/java/expo/modules/t3composereditor/T3ComposerEditorModule.kt",
    refs: { "app.t3.codes": 1 },
    reason: HOSTED,
  },
  {
    file: "apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorModule.swift",
    refs: { "app.t3.codes": 1 },
    reason: HOSTED,
  },
  {
    file: "apps/mobile/src/features/settings/lib/legal-document-url.ts",
    refs: { "t3.codes": 1 },
    reason: HOSTED,
  },
  { file: "apps/server/package.json", refs: { "pingdotgg/t3code": 1 }, reason: REPOSITORY },
  {
    file: "apps/server/scripts/acp-mock-agent.ts",
    refs: { "t3.codes": 5, "pingdotgg/t3code": 1 },
    reason: FIXTURE,
  },
  {
    file: "apps/server/src/auth/McpOAuth.ts",
    refs: { "app.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#49"],
  },
  {
    file: "apps/server/src/cloud/publicConfig.ts",
    refs: { "nightly.app.t3.codes": 1, "app.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#49"],
  },
  {
    file: "apps/server/src/policy/policyTemplates.ts",
    refs: { "app.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#49"],
  },
  {
    file: "apps/server/src/project/ManagedProjectFolders.ts",
    refs: { "t3.codes": 1 },
    reason: BRAND,
  },
  {
    file: "apps/server/src/provider/ModelManifest.ts",
    refs: { "pingdotgg/t3code": 1 },
    reason: REPOSITORY,
    tracking: ["#72"],
  },
  { file: "apps/server/src/push/WebPushStore.ts", refs: { "t3.codes": 1 }, reason: BRAND },
  {
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    refs: { "ingest.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#57"],
  },
  {
    file: "apps/server/src/triage/TriageService.ts",
    refs: { "pingdotgg/t3code": 1, "app.t3.codes": 1 },
    reason: REPOSITORY,
    tracking: ["#71"],
  },
  {
    file: "apps/server/src/triage/triagePrompt.ts",
    refs: { "pingdotgg/t3code": 7, "app.t3.codes": 1 },
    reason: REPOSITORY,
    tracking: ["#71"],
  },
  { file: "apps/web/src/branding.ts", refs: { "t3.codes": 1 }, reason: HOSTED },
  {
    file: "apps/web/src/components/desktopUpdate.logic.ts",
    refs: { "pingdotgg/t3code": 1 },
    reason: REPOSITORY,
  },
  {
    file: "apps/web/src/components/settings/MultipleAccountsNote.tsx",
    refs: { "pingdotgg/t3code": 1 },
    reason: REPOSITORY,
  },
  {
    file: "apps/web/src/legalLinks.ts",
    refs: { "t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#57"],
  },
  {
    file: "apps/web/vercel.ts",
    refs: { "app.t3.codes": 1, "latest.app.t3.codes": 1, "nightly.app.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#49"],
  },
  {
    file: "infra/relay/src/mobileTelemetry/monitoring.ts",
    refs: { "pingdotgg/t3code": 1 },
    reason: REPOSITORY,
  },
  {
    file: "infra/relay/src/monitoring.ts",
    refs: { "pingdotgg/t3code": 1, "relay.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#77"],
  },
  {
    file: "infra/task-cache/scripts/install-ci.ts",
    refs: { "pingdotgg/t3code": 1 },
    reason: REPOSITORY,
  },
  {
    file: "packages/contracts/src/environmentHttp.ts",
    refs: { "pingdotgg/t3code": 1 },
    reason: REPOSITORY,
  },
  { file: "packages/contracts/src/t3ProjectFile.ts", refs: { "t3.codes": 2 }, reason: BRAND },
  {
    file: "packages/shared/src/connectAuth.ts",
    refs: { "app.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#49"],
  },
  { file: "packages/shared/src/icalGenerator.core.ts", refs: { "t3.codes": 1 }, reason: BRAND },
  {
    file: "packages/shared/src/providerAuthReturnUrl.ts",
    refs: { "app.t3.codes": 1 },
    reason: HOSTED,
    tracking: ["#49"],
  },
  {
    file: "packages/source-control-github/src/server/githubStackRebase.ts",
    refs: { "t3.codes": 1 },
    reason: BRAND,
  },
];

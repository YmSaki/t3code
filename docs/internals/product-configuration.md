# Product configuration

> For maintainers. Authoritative ownership and isolation rules for T3CodeJP product identity, release configuration, runtime settings, and secrets. See [Domain model](./domain-model.md#product-and-distribution-domain) for the conceptual model behind these categories.

## Sources of truth

> Each fact has one authoritative definition, one owner, and explicit resolution rules. This does not require one configuration file.

Derive platform-specific settings (GitHub Releases, Electron builders, Expo/EAS profiles) from the T3CodeJP product domain model rather than defining domain behavior from platform configs. Separate configuration into four ownership categories so public product metadata, release trust boundaries, runtime preferences, and credentials never mix:

1. **Product identity** — Public metadata identifying the product and isolating its local state.
2. **Release and deployment** — Distribution targets, update feeds, hosted endpoints, channels, and signing policy.
3. **Runtime configuration** — Client, environment, and project settings resolved at runtime.
4. **Secrets** — Credentials injected at CI or runtime boundaries.

## Resolution owner

[productConfig.ts](../../packages/shared/src/productConfig.ts) resolves the raw inputs into one validated `ProductConfig` per build or release: distribution (`T3CODE_DISTRIBUTION`, `upstream` or `fork`), hosted Web, Connect, mobile release identity, and link policy. Web, Desktop, CLI, Mobile, and release workflows derive from that result and never re-validate it.

- An unconfigured optional service is `disabled`, never an upstream default. Partial or upstream-owned fork values, and fork-only values in an upstream build, fail the build.
- Links separate generation from acceptance: `links.generate` is null without a hosted Web, and `links.accept` is the only place the upstream compatibility origins appear. Provider-auth return targets use `links.authReturn`, which excludes them.
- An unbuilt source tree is the upstream distribution; fork builds always define the resolved public config.

## Product identity

- Shared product identity (product name, slug, desktop app ID, default home directory, and URL schemes) is owned by [productIdentity.ts](../../packages/shared/src/productIdentity.ts).
- Generated platform manifests and build outputs (Electron, Expo, installers) are derived artifacts, never a second source of truth. Verify parity with the source definition in build or unit tests.
- Never infer product identity, update targets, or isolation boundaries from UI display labels or Git repository names.

## Release and deployment

- Distribution targets, update channels, hosted Web/relay endpoints, and signing requirements must be defined and validated at the build or release workflow boundary.
- Production and public release paths must fail closed: if required signing credentials, notarization, or verification inputs are missing, stop the build or publish step rather than silently downgrading to unsigned artifacts.
- Unsigned or local development modes are permitted only when explicitly selected by mode or flag.

## Runtime configuration

- Ownership of client, environment, and project settings follows [Settings ownership](./overview.md#settings-ownership).
- Read environment variables, CLI flags, and config files once at the process startup or build boundary, validate them into typed values, and pass those values inward.
- Consumers inside core, services, or UI must not read raw environment variables or invent local fallback precedence.

## Secrets

- Inject signing keys, API tokens, and signed mirror URLs (including query-parameter credentials) strictly from CI or runtime environment boundaries.
- Never embed secrets in public product definitions, client bundles, diagnostic error messages, or failure logs.

## Fork isolation and resolution

- Keep T3CodeJP isolated from upstream T3 Code across data directories, app IDs, update feeds, and auth/connect endpoints.
- When required fork configuration is missing or unreachable, reject the boundary-crossing operation; never silently fall back to upstream endpoints or data locations.
- When an optional capability (such as Connect, hosted Web, or OTA updates) is intentionally unconfigured, represent and handle it as an explicitly disabled valid state.
- Absorb product differences at configuration resolution boundaries or adapters rather than spreading `isFork` checks through core logic or client components.

# Domain model

> For maintainers. Domain modeling rules and core conceptual relationships for T3CodeJP. Shared term definitions live in [Glossary](./glossary.md); lifecycle and persistence constraints live in [Overview](./overview.md).

## Modeling rules

Before implementing a change that introduces or alters domain concepts (`H1`, `H5`), establish five facts explicitly:

1. **Concepts** — Distinct entities and value objects, using existing [Glossary](./glossary.md) terms without local redefinition.
2. **Relationships and multiplicity** — Ownership and cardinality (such as `1 -> 0..*`).
3. **Lifecycle states and transitions** — Valid states, allowed transitions, and terminal states.
4. **Authoritative owner** — Which domain service or package owns creation, mutation, and persistence.
5. **Invariants** — Conditions that must hold across all valid states, retries, and failures.

Derive storage schemas, RPC contracts, and configuration structures from the domain model—never infer domain ownership backward from UI layout or ad-hoc environment variables.

## Core execution domain

- **Environment (`1`) -> Project (`0..*`)**: An environment owns its filesystem, credentials, and local project records.
- **Project (`1`) -> Worktree (`0..*`) / Thread (`0..*`)**: Threads belong to a project and may bind to a dedicated worktree or task folder.
- **Thread (`1`) -> Turn / Run (`0..*`)**: Each turn records intent as **Events** and updates **Projections**, **CommandReceipts**, and **OutboxEffects** atomically via `EventSink`, then captures **Checkpoints** as hidden Git refs.
- **Provider / Driver (`1`) -> ProviderInstance (`0..*`) -> Session (`0..1` active per Thread)**: Provider adapters translate native protocols into normalized orchestration commands and events; a thread survives session termination.

## Product and distribution domain

Changes touching branding, packaging, updates, hosted services, or fork isolation must model configuration against these relationships rather than scattered flags:

- **Product (`1`) -> Distribution form (`Desktop` | `CLI` | `Web` | `Mobile`) -> Platform (`macOS` | `Windows` | `Linux` | `iOS` | `Android` | `Browser`)**: Determines derived app identifiers, data directories, and URL schemes from one identity owner.
- **Product (`1`) -> Release (`0..*`) -> Channel (`Stable` | `Nightly` | `Dev`)**: Determines update feeds, binary naming, and mandatory signing/notarization policy.
- **Product (`1`) -> External service (`Auth` | `Relay` | `Hosted Web` | `OTA`) -> Service configuration (`Disabled` | `Configured`)**: Distinguishes intentionally disabled optional services from misconfigured required boundaries.

Together, **Distribution form + Platform + Channel + Service configuration** resolve once at the startup or build boundary into a validated **Effective product configuration** governed by [Product configuration](./product-configuration.md).

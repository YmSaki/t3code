# Domain model

> For maintainers. Domain modeling rules and core conceptual relationships for T3CodeJP. Shared term definitions live in [Glossary](./glossary.md); lifecycle and persistence constraints live in [Overview](./overview.md).

## Modeling rules

Before implementing a change that introduces or alters domain concepts (`H1`, `H5`), establish five facts explicitly:

1. **Concepts** — Distinct entities and value objects, using existing [Glossary](./glossary.md) terms without local redefinition.
2. **Relationships and multiplicity** — Ownership and cardinality (such as `1 -> 0..*`).
3. **Lifecycle states and transitions** — Valid states, allowed transitions, and terminal states.
4. **Authoritative owner** — Which domain service or package owns creation, mutation, and persistence.
5. **Invariants** — Conditions that must hold across all valid states, retries, and failures.

Wire contracts (`packages/contracts`), internal domain models, and persistence models serve different purposes and may define explicit translation boundaries. However, never duplicate the same domain concept, enum, or validation rule independently across boundaries. Derive storage schemas, RPC contracts, and configuration structures from the domain model—never infer ownership backward from UI layout or ad-hoc environment variables.

## Core execution domain

Separate individual command atomicity from multi-step turn execution:

- **Environment (`1`) -> Project (`0..*`)**: An environment owns its filesystem, credentials, and local project records.
- **Project (`1`) -> Worktree (`0..*`) / Thread (`0..*`)**: Threads belong to a project and may bind to a dedicated worktree or task folder.
- **Provider / Driver (`1`) -> ProviderInstance (`0..*`) -> Session (`0..1` active per Thread)**: Provider adapters translate native protocols into normalized orchestration commands and events; a thread survives session termination.
- **Command transaction boundary (atomic):** One `Command` enters `Orchestrator` (pure decision with no I/O) and commits `Event`, `Projection`, `CommandReceipt`, and `OutboxEffect` atomically in a single `EventSink` transaction.
- **Turn / Run lifecycle (multi-transaction workflow):** One `Turn` spans multiple independent command transactions and asynchronous `OutboxEffect` executions across time (start command, provider turn execution in `EffectWorker`, intermediate events, run finalization, and subsequent `Checkpoint` capture).

## Product and distribution domain

Do not conflate T3CodeJP domain concepts with platform-specific mechanisms (such as GitHub Releases tags, Electron NSIS/DMG targets, or Expo/EAS build profiles), and do not merge independent axes into one enum (for example, mobile `preview:dev` combines a preview distribution/release track with a development client build form).

- Separate only dimensions that vary independently (such as execution/runtime mode, build variant, release/distribution track, product identity, and external service enablement); derive platform manifests, update feeds, signing policies, and data isolation paths from those domain dimensions rather than inferring them from labels or repository names.
- The exact minimal set of independent product-distribution axes is governed by explicit design agreement before implementation (`H5`) and enforced via [Product configuration](./product-configuration.md).

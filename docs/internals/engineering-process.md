# Engineering process

> For maintainers. Staged design workflow and Design Gate execution rules for `H5` and `H6` in [AGENTS.md](../../AGENTS.md#t3codejp-governance-hard-rules).

## Seven stages

Distinguish seven stages for changes that cross architectural, domain, or trust boundaries:

1. **01. Request** — What outcome is wanted.
2. **02. Requirements** — Conditions that must hold for the request to succeed.
3. **03. Basic specification** — External behavior, including failure modes and edge cases.
4. **04. Basic design** — Components, domain model, authoritative owners, and boundaries.
5. **05. Detailed design** — Concrete types, data flows, state transitions, and interfaces.
6. **06. Implementation** — Realizing the agreed design.
7. **07. Verification** — Proving conformance to requirements, specification, and design.

Do not re-specify stages that are already settled and documented. However, **never invent undecided requirements, specifications, or design decisions during implementation (`H5`)**—surface and agree on them before editing code.

Match artifact depth to change scope: small or medium gated changes may use the seven-field design brief below; large changes spanning multiple domains, surfaces, or release/trust boundaries must settle each undecided stage (`02`–`05`) explicitly before implementation rather than compressing them into one-line bullets.

## Workflow

1. **Classify** — Tentatively classify the task as a local fix or a gated change. Never classify by line or file count alone.
2. **Locate owner and boundary** — Identify the domain owner, [Domain model](./domain-model.md) concepts, source of truth, and allowed package layers in [Overview](./overview.md). Upgrade to gated if inspection reveals a boundary or ownership change.
3. **Resolve undecided stages and agree** — For gated changes, complete the design brief (and staged artifacts for large changes) and obtain agreement before code edits. Reuse an existing explicit agreement while its scope and assumptions hold.
4. **Implement and prove** — Implement within agreed boundaries and prove invariants and failure paths per [Testing](./testing.md).

## Design Gate and agreement

The authoritative trigger list lives in [AGENTS.md](../../AGENTS.md#design-gate).

A change is **not** gated when it stays within existing owners, contracts, and invariants—for example, a bug fix inside an existing service or adapter, adding a case to an established pattern, or propagating an existing contract across surfaces without altering ownership.

- **What waits for agreement:** Edits that commit a gated design. Read-only investigation and concrete verification planning may continue while waiting.
- **Where agreement lives:** Record the agreement on the existing issue or PR when one exists; explicit agreement in the active conversation is also valid. Do not create issues, open PRs, or post external comments solely to record a brief unless requested.
- **PR cohesion (`H6`):** One PR covers one independently reviewable outcome. Keep `contracts`, `server`, `web`, and `mobile` changes together when one fix requires them; split only when independent outcomes can be reviewed and accepted separately, and include any split in the brief agreement.
- **Exceptions:** Breaking a hard rule requires explicit maintainer agreement naming the rule, reason, and compensating guard. Existing violations do not justify adding new ones.

## Design brief

For small or medium gated changes, keep each field concise and state a reason for any field that does not apply. For large cross-cutting changes, expand fields `1`–`5` into explicit `02`–`05` stage decisions before implementation. Do not commit temporary briefs to the repository.

1. **Problem and non-goals** (`01`–`02`) — Required outcome, acceptance conditions, and explicit non-goals.
2. **Owner and sources of truth** (`04`) — Authoritative domain owner, concepts, and configuration/data sources of truth.
3. **Boundaries and dependencies** (`04`–`05`) — Package layers, Core/Shell/Adapter boundaries, and dependency directions affected.
4. **Invariants and failure behavior** (`03`–`05`) — Behavior on success and which crossing operation rejects fail-closed on failure.
5. **Affected surfaces and compatibility** (`03`–`05`) — Clients, connection modes, wire contracts, state transitions, and persisted data.
6. **Proof** (`07`) — Unit and integration tests or runtime evidence verifying each invariant and failure path.
7. **Delivery and recovery** (`07`) — Required migrations, rollout, rollback, and any agreed PR split.

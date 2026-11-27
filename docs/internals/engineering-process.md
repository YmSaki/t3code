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

Match artifact depth to change scope: small or medium gated changes may use the design brief below; large changes spanning multiple domains, surfaces, or release/trust boundaries must settle each undecided stage (`02`–`05`) explicitly before implementation rather than compressing them into one-line bullets.

## Workflow

1. **Classify** — Tentatively classify the task as a local fix or a gated change. Never classify by line or file count alone.
2. **Locate owner and boundary** — Identify the domain owner, [Domain model](./domain-model.md) concepts, source of truth, and dependency rules in [Overview](./overview.md). Upgrade to gated if inspection reveals undecided specifications or boundary/ownership changes.
3. **Resolve undecided stages and agree** — For gated changes, present the design evaluation artifacts below and obtain agreement before code edits. Reuse an existing explicit agreement while its scope and assumptions hold.
4. **Implement and prove** — Implement within agreed boundaries and prove invariants and failure paths per [Testing](./testing.md).

## Design Gate and agreement

The Design Gate exists to **validate design soundness and keep undecided specifications out of implementation**—not to impose formal approval rituals on routine work or implementer-discretion details. The authoritative trigger list lives in [AGENTS.md](../../AGENTS.md#design-gate).

A change is **not** gated when requirements and specifications are already settled and it stays within existing owners, contracts, and invariants—for example, a bug fix inside an existing service or adapter, adding a case to an established pattern, or propagating an existing contract across surfaces without altering ownership.

- **What waits for agreement:** Edits that commit a gated design. Read-only investigation and concrete verification planning may continue while waiting.
- **Where agreement lives:** Record the agreement on the existing issue or PR when one exists; explicit agreement in the active conversation is also valid. Do not create issues, open PRs, or post external comments solely to record a brief unless requested.
- **PR cohesion (`H6`):** One PR covers one independently reviewable outcome. Keep `contracts`, `server`, `web`, and `mobile` changes together when one fix requires them; split only when independent outcomes can be reviewed and accepted separately, and include any split in the agreement.
- **Exceptions:** Breaking a hard rule requires explicit maintainer agreement naming the rule, reason, and compensating guard. Existing violations do not justify adding new ones.

## Material design decisions and brief

Material design decisions must provide enough information to evaluate soundness rather than merely requesting sign-off. State clearly what is protected, what is optimized, and what is traded off, covering at least these eight points:

1. **Problem and root cause** (`01`–`02`) — The underlying problem, root cause, and non-goals.
2. **Constraints** (`02`–`03`) — Mandatory invariants, trust boundaries, compatibility, and operational limits.
3. **Reasonable candidates** (`04`) — Viable design options, including keeping or extending existing structure when applicable.
4. **Comparison** (`04`) — Trade-offs across candidates (complexity, maintainability, performance, failure behavior).
5. **Selection rationale** (`04`–`05`) — Why the chosen option wins, what is optimized, and what is sacrificed.
6. **System-wide impact** (`03`–`05`) — Affected domains, surfaces, package boundaries, and contracts.
7. **Invariants to preserve** (`03`–`05`) — Conditions that must hold on success, failure, retry, and recovery.
8. **Verification plan** (`07`) — Unit, integration, and runtime checks proving each invariant and failure mode.

For smaller gated changes, keep each item concise; for large cross-cutting changes, expand undecided `02`–`05` stage artifacts explicitly. Do not commit temporary briefs to the repository.

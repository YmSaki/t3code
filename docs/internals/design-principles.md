# Design principles

> For maintainers. Application guide for the T3CodeJP hard rules (`H1`–`H6`) defined in [AGENTS.md](../../AGENTS.md#t3codejp-governance-hard-rules).

## Workflow

1. **Classify** — Tentatively determine whether the task is a local fix or a gated change that alters ownership, boundaries, or guarantees. Do not classify by line or file count.
2. **Locate owner and boundary** — Identify the existing domain owner, source of truth, resolution precedence, and dependency direction. Upgrade the classification to gated if inspection reveals a boundary change.
3. **Brief** — For gated changes only, agree on the seven-field design brief (1–2 lines per field). Reuse an existing explicit agreement when its scope and assumptions still hold.
4. **Implement and prove** — Implement within the agreed boundaries and prove the invariants and failure paths at the lowest layer that fails without the fix.

## Design Gate and agreement

The authoritative trigger list lives in [AGENTS.md](../../AGENTS.md#design-gate).

A change is **not** gated when it stays within existing owners, contracts, and invariants—for example, a bug fix inside an existing service or adapter, adding a case to an established pattern, or propagating an existing contract across surfaces without altering ownership.

- **What waits for agreement:** Edits that commit a gated design. Read-only investigation and concrete verification planning may continue while waiting.
- **Where agreement lives:** Record the brief on the existing issue or PR when one exists; explicit agreement in the active conversation is also valid. Do not create issues, open PRs, or post external comments solely to record a brief unless requested.
- **PR cohesion (`H6`):** One PR covers one independently reviewable outcome. Keep `contracts`, `server`, `web`, and `mobile` changes together when one fix requires them; split only when independent outcomes can be reviewed and accepted separately, and include any split in the brief agreement.
- **Exceptions:** Breaking a hard rule requires explicit maintainer agreement naming the rule, reason, and compensating guard. Existing violations do not justify adding new ones.

## Design brief

Keep gated briefs to 1–2 lines per field. State a brief reason for any field that does not apply. Do not commit temporary briefs to the repository.

1. **Problem and non-goals** — What outcome is required and what is explicitly out of scope.
2. **Owner and sources of truth** — Which domain owns the responsibility, facts, and resolution rules.
3. **Boundaries and dependencies** — Which boundaries or dependency directions change.
4. **Invariants and failure behavior** — What must remain true on success and which crossing operation is rejected on failure.
5. **Affected surfaces and compatibility** — Impact on clients, connection modes, wire contracts, and persisted state.
6. **Proof** — Which tests or runtime checks verify the invariants and failure paths.
7. **Delivery and recovery** — Required migrations, rollout, rollback, and any agreed PR split.

## Ownership and dependency boundaries

- **One owner per fact (`H1`):** Resolve product and deployment differences at the startup/build boundary or inside adapters; pass normalized capabilities and typed config inward. Never scatter `isFork` branches across core logic or clients, and never turn `packages/contracts` into a dumping ground for product-specific configuration.
- **Core, shell, and services (`H2`):** Follow [Functional core, imperative shell](./functional-core-shell.md) for pure decision modules (`*.core.ts`), [Effect services](./effect-services.md) for service layers and thin transports, and [Architecture](./overview.md) for ownership and durable state boundaries.

## Failure boundaries

> When a required boundary condition cannot be established, reject the operation that would cross that boundary. Optional failures disable the affected capability unless safe operation of the whole system depends on it.

- Do not crash the entire application when an optional capability fails or is unconfigured.
- Do not silently fall back to upstream endpoints, another environment, or unsigned release artifacts when a trust boundary check fails.
- Any compatibility fallback must state its target, trigger condition, observability signal, and removal condition.

## Good defaults and review

### Good defaults

- Extend an existing domain owner before introducing a new service or package.
- Model valid states explicitly with discriminated types instead of boolean flag combinations.
- Deduplicate decisions that change for the same reason; tolerate superficial similarity across independent domains.
- Express constraints in names, types, and dependencies rather than duplicating them in comments or prose.
- Tidy only what the task touches; keep unrelated refactors out of the change.

### Review criteria

Evaluate gated and non-gated changes on design integrity as well as behavior:

- No duplicate decision points or downstream re-interpretation of resolved configuration.
- No local redefinition of an existing domain concept.
- Invariants hold across failure, disconnect, retry, and legacy data.
- All entry points and surfaces reach the same authoritative owner.
- Tests verify invariants and forbidden failure modes rather than mirroring implementation steps.

### Mechanical guard policy

Enforce syntax-detectable boundaries (such as configuration access sites and Core/Shell import directions) with lint rules, and enforce semantic invariants and failure paths with focused tests.

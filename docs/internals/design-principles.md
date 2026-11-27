# Design principles

> For maintainers. Design philosophy, trade-off criteria, and architectural placement rules supporting `H1`–`H6` in [AGENTS.md](../../AGENTS.md#t3codejp-governance-hard-rules). See [Engineering process](./engineering-process.md) for the staged workflow and [Review](./review.md) for review and enforcement criteria.

## Design philosophy

Distinguish three classes of design constraints so principles are applied with judgment rather than mechanically:

1. **Mandatory invariants and trust boundaries** — Requirements, data invariants, and fail-closed trust boundaries that must hold unconditionally.
2. **Quality attributes to optimize within constraints** — Performance, reliability, maintainability, and implementation cost, whose relative weights depend on requirements and system constraints. Material design decisions must state what is protected, what is optimized, and what is traded off.
3. **Implementer discretion** — Local implementation details within agreed boundaries and constraints.

Evaluate trade-offs against total system health rather than local convenience:

1. **Global optimality over local optimality.** Moving responsibility to the right boundary may add explicit error handling at callers; that is healthy when it clarifies the boundary, whereas shifting unnecessary branching, retries, or workaround complexity onto callers degrades the system.
2. **Root cause over symptom relief.** Fix the underlying invariant, ownership, or boundary defect instead of patching downstream symptoms.
3. **Minimize total complexity.** Judge a change by the complexity of the whole system after the change, not by the size of one local diff.
4. **Make invalid states unrepresentable.** Encode valid states and transitions in types and module structure rather than scattering runtime guards.
5. **Consistent solutions for equivalent problems.** Reuse one established pattern per problem class; do not invent parallel mechanisms for the same job.
6. **High cohesion, low coupling.** Keep logic that changes for the same reason together, and isolate independent concerns behind narrow boundaries.
7. **Optimize for changeability.** Leave the next related change easier and safer to make, not harder.
8. **Do not assume legacy design is right.** Distinguish intentional architecture in [Overview](./overview.md) from historical leftovers; never copy legacy shortcuts into new work.
9. **Eliminate unnecessary machinery.** Remove speculative abstractions, redundant flags, and dead branches.

## Placement, abstraction, and adapter criteria

- **Pure domain decisions** (`*.core.ts`): Place deterministic calculations, state transitions, and validation rules with no I/O in functional core modules inside the owning domain per [Functional core, imperative shell](./functional-core-shell.md). Being pure does not by itself justify placing single-domain logic in `packages/shared`.
- **Stateful workflows and side effects**: Place I/O, persistence, and orchestration in Effect services per [Effect services](./effect-services.md), keeping RPC, HTTP, and MCP transports thin.
- **Shared client logic**: Place multi-surface connection and client domain logic in `packages/client-runtime`, never duplicated across `apps/web`, `apps/desktop`, and `apps/mobile`.
- **Adapters and abstraction boundaries**: Introduce an adapter only to isolate external systems, provider protocols, forges, or platform differences behind a normalized domain contract. Shared abstractions are justified only when callers share the same reason to change—not for superficial code similarity.
- **Product and fork isolation (`H1`, `H3`)**: Resolve product and deployment differences at startup/build boundaries or adapters; pass typed capabilities inward. Never scatter `isFork` checks across core logic or clients, and never turn `packages/contracts` into a dumping ground for product-specific configuration.

## Failure boundaries

> When a required boundary condition cannot be established, reject the operation that would cross that boundary. Optional failures disable the affected capability unless safe operation of the whole system depends on it.

- Do not crash the entire application when an optional capability fails or is unconfigured.
- Do not silently fall back to upstream endpoints, another environment, or unsigned release artifacts when a trust boundary check fails.
- Any compatibility fallback must state its target, trigger condition, observability signal, and removal condition.

## Good defaults

- Extend an existing domain owner before introducing a new service or package.
- Model valid states explicitly with discriminated types instead of boolean flag combinations.
- Express constraints in names, types, and dependencies rather than duplicating them in comments or prose.
- Tidy only what the task touches; keep unrelated refactors out of the change.

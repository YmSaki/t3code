# Review

> For maintainers and review agents. Design, specification, and code review criteria for `H1`–`H6` in [AGENTS.md](../../AGENTS.md#t3codejp-governance-hard-rules).

## Eight review dimensions

Evaluate every change against these eight dimensions in addition to functional correctness:

| Dimension                 | Review question                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Requirement fit**       | Does it satisfy the actual requirement without scope drift or unagreed assumptions?                                                          |
| **Root-cause resolution** | Does it fix the underlying invariant or ownership defect instead of patching downstream symptoms?                                            |
| **Global optimality**     | Does it avoid shifting complexity, branching, or error handling onto callers or sibling layers?                                              |
| **Domain consistency**    | Does it reuse existing [Domain model](./domain-model.md) concepts and owners without duplicate definitions?                                  |
| **Structural alignment**  | Does it respect package layers in [Overview](./overview.md), Core/Shell/Adapter boundaries, and [Design principles](./design-principles.md)? |
| **Minimality**            | Is it free of unnecessary states, flags, fallback branches, and speculative abstractions?                                                    |
| **Maintainability**       | Does it leave the next related change straightforward and safe?                                                                              |
| **Verifiability**         | Do focused unit and (where needed) integration tests prove invariants and failure paths objectively?                                         |

## Blocking criteria

Block merge when any of the following holds:

- Violation of `H1`–`H6` or fail-closed trust boundaries in [Product configuration](./product-configuration.md).
- Undecided requirements, specifications, or design decisions invented during implementation without prior agreement (`H5`).
- Local simplification that increases total system complexity or introduces a second source of truth.
- Missing proof for changed behavior, failure paths, or cross-component invariants per [Testing](./testing.md).

## Mechanical enforcement policy

Enforce syntax-detectable boundaries with lint rules (such as configuration access sites and layer or Core/Shell import directions) and enforce semantic invariants, failure paths, and cross-component guarantees with focused tests. Add new rules to `oxlint-plugin-t3code` and CI incrementally, starting with low-false-positive checks.

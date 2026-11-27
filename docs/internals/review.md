# Review

> For maintainers and review agents. Design, specification, and code review criteria for `H1`–`H6` in [AGENTS.md](../../AGENTS.md#t3codejp-governance-hard-rules).

## Mechanical checks vs. design review

Separate what static/automated checks can verify reliably from what requires human or review-agent judgment. Never treat passing mechanical checks as proof that semantic or design violations are absent.

| Verification mode                                            | What it checks                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mechanical checks** (precise rules in lint, CI, and tests) | Prohibited package/module dependency directions, dependency cycles, I/O inside `*.core.ts` / `*.logic.ts`, configuration reads outside designated resolution boundaries, unintended references to upstream services/URLs, mechanically detectable contract/schema mismatches, and unit/integration tests for critical invariants. |
| **Design review** (human and review-agent judgment)          | Semantic duplication of domain concepts, misplaced domain ownership, unnecessary abstractions, local simplifications that worsen total system complexity, and whether the change fixes the root cause rather than symptoms.                                                                                                       |

## Eight review dimensions

Evaluate every change against these eight dimensions in addition to functional correctness:

| Dimension                 | Review question                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Requirement fit**       | Does it satisfy the actual requirement without scope drift or unagreed assumptions?                                                                              |
| **Root-cause resolution** | Does it fix the underlying invariant or ownership defect instead of patching downstream symptoms?                                                                |
| **Global optimality**     | Does it avoid shifting unnecessary complexity, branching, or error handling onto callers or sibling layers?                                                      |
| **Domain consistency**    | Does it reuse existing [Domain model](./domain-model.md) concepts and owners without duplicate definitions?                                                      |
| **Structural alignment**  | Does it respect package roles and dependency rules in [Overview](./overview.md), Core/Shell/Adapter boundaries, and [Design principles](./design-principles.md)? |
| **Minimality**            | Is it free of unnecessary states, flags, fallback branches, and speculative abstractions?                                                                        |
| **Maintainability**       | Does it leave the next related change straightforward and safe?                                                                                                  |
| **Verifiability**         | Do focused unit and (where needed) integration tests prove invariants and failure paths objectively?                                                             |

## Blocking criteria

Block merge when any of the following holds:

- Violation of `H1`–`H6` or fail-closed trust boundaries in [Product configuration](./product-configuration.md).
- Undecided requirements, specifications, or design decisions invented during implementation without prior agreement (`H5`).
- Local simplification that increases total system complexity or introduces a second source of truth.
- Missing proof for changed behavior, failure paths, or cross-component invariants per [Testing](./testing.md).

## Technical debt baseline policy

Existing rule violations are technical debt—never permanent exceptions to new rules:

1. **Identify individually:** Record each known violation at file/symbol granularity, not by exempting entire files or packages.
2. **Document context:** Record the evidence location, origin, violated principle, system impact, and recommended remediation.
3. **Ratchet strictly:** Block any new violations and any expansion of existing violations.
4. **Shrink on fix:** Remove resolved entries from the baseline immediately when fixed.
5. **Exclude unmerged PRs:** Violations in unmerged PRs are never grandfathered as baseline debt; fix them before merge.

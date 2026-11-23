# Functional core, imperative shell

> For maintainers. Using T3 Code? See [docs/user](../user/).

Decision logic is a pure function of its inputs. I/O, time, randomness, and environment access live at the edge, in Effect services. Pure code is tested with plain values and no layers, and a service stays a thin shell that gathers inputs, calls the core, and applies the result. Read [Effect services](effect-services.md) for the service side; this page draws the line between the two.

## The boundary

| Core (`*.core.ts`)                                       | Shell (Effect service, transport handler)                        |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| Pure functions over plain data and `effect/Schema` types | Reads the clock, filesystem, database, network, process env      |
| Returns a decision, a plan, or a new value               | Executes the plan and maps typed errors to the transport         |
| Takes `now`, ids, and config as arguments                | Supplies `now`, ids, and config from `Clock`, services, `Config` |
| Tested with `it` and fixed inputs                        | Tested with `it.effect` and a test layer                         |

Push I/O outward. If a function needs a timestamp, an id, or an env value, the caller passes it in. Do not add a `Clock` or `FileSystem` requirement to a core function to avoid the argument: that moves the I/O inside instead of out.

## Naming and layout

- A core module is named `<topic>.core.ts` and sits beside the service that calls it, in the same domain folder. Its tests are `<topic>.core.test.ts`.
- `*.logic.ts` files are functional core too and the lint rule below covers them. A few upstream web `*.logic.ts` files that predate the rule are exempted by name in `vite.config.ts`; do not add to that list. Name new pure modules `*.core.ts`; do not rename old ones as a drive-by.
- A core module exports plain functions and types. No `Context.Service`, no `Layer`, no module-level mutable state.
- Effect itself is fine in a core file when it stays pure: `Option`, `Result`, `Schema`, `Data`, `Array`, and `Effect` values that only compose other pure values.

## Forbidden in `*.core.ts`

The `t3code/no-io-in-functional-core` rule ([source](../../oxlint-plugin-t3code/rules/no-io-in-functional-core.ts)) reports these in `*.core.ts` and `*.logic.ts`, plus their `.cts`, `.mts`, `.js`, and `.tsx` variants. Test files (`*.test.*`, `*.spec.*`) are exempt, so `foo.core.test.ts` may use fixtures freely.

| Kind        | Forbidden                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imports     | `node:*`, `effect/FileSystem`, `effect/sql`, `effect/unstable/sql`, `@effect/sql`, `@effect/platform-node`, `@effect/platform-node-shared` (static, dynamic, and re-export forms; subpaths included) |
| Network     | global `fetch(...)`, `globalThis.fetch(...)`                                                                                                                                                         |
| Time        | `Date.now` (call or reference), `new Date()` with no arguments                                                                                                                                       |
| Randomness  | `Math.random`, `crypto.randomUUID`                                                                                                                                                                   |
| Environment | `process.env`                                                                                                                                                                                        |

`new Date(iso)` and `Date.parse` are allowed: they are pure for a given input.

## Calling a core from a service

The service is the only place that touches the world. It reads inputs, calls the core once, and applies the outcome.

```ts
// apps/server/src/scheduledTasks/nextRun.core.ts
export const nextRun = (schedule: Schedule, now: number): Option.Option<number> => /* pure */;

// apps/server/src/scheduledTasks/ScheduledTaskService.ts
const reschedule = Effect.fn("ScheduledTaskService.reschedule")(function* (task: ScheduledTask) {
  const now = yield* Clock.currentTimeMillis;
  const next = nextRun(task.schedule, now);
  yield* repository.save({ ...task, nextRunAt: Option.getOrNull(next) });
});
```

Keep the seam coarse: one call that returns a decision beats many fine-grained calls that each need the shell in between. When a core needs data it cannot compute, it returns what it needs (a "request" value) and the shell fetches it and calls again, rather than the core reaching out.

## MCP context budget

Everything a provider sees up front costs tokens on every turn. [`agentContextBudget.json`](../../apps/server/src/provider/agentContextBudget.json) records three measured sizes, checked by [`AgentContextBudget.test.ts`](../../apps/server/src/provider/AgentContextBudget.test.ts):

| Key                           | What it measures                                     |
| ----------------------------- | ---------------------------------------------------- |
| `claudeSystemAppendBytes`     | Text appended to Claude's system prompt              |
| `codexAdditionalContextBytes` | Additional developer context sent to Codex           |
| `mcpToolListJsonBytes`        | JSON of the MCP tool list a client receives up front |

CI rejects a change that raises any value above `main`. Treat the file as a ceiling: to add text, remove or defer something of equal size, and run the model evals ([evals/README.md](../../evals/README.md)) before cutting wording to fit.

### Tool exposure and `tool_search`

[`McpToolExposure`](../../apps/server/src/mcp/McpToolExposure.ts) defers most tools. A deferring client lists only the direct tools, then calls `tool_search` to load more into its session.

- **Direct (always listed):** `orchestrator_capabilities`, `delegate_task`, `task_status`, `tool_search`. This set is deliberately tiny and is the only allocation that costs budget on every turn.
- **Deferred (default for new tools):** everything else. A search returns at most 10 tools, ranked by name then description match, and lists them to that provider session from then on.
- **Promoting a tool to direct** needs a reason: it is needed on nearly every turn and cannot be found reliably by search. State the byte cost against `mcpToolListJsonBytes` in the PR.
- **Descriptions are the search index.** Put the verbs and nouns a model would query in the tool name and first sentence; long prose inflates the budget without improving recall.

A new tool is deferred, searchable by a plain query, and adds no more than its description bytes to the measured list. A feature that only a core decision needs does not become a tool at all: expose the service method and let the existing MCP toolkit call it.

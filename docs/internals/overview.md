# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

### Pull request linking compatibility

Every protocol-2 environment advertises `threadPullRequests`. Once an environment's server config
has loaded, clients use persisted `pullRequests[]`, multi-link commands, stack UI, and reverse thread
lookup. Before that, they hide linking actions.

Environments keep advertising `threadPullRequestLinking`, accepting legacy metadata commands, and
emitting the derived `linkedPullRequest` field, because older clients still read them. That
hostless field includes only links in the thread project's own repository. Retain the legacy wire
fields, projection column, and replay support.

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Dependency model and package roles

Evaluate dependencies across three independent axes rather than conflating them in one hierarchy:

- **Phase (when needed):** Runtime, build/bundle, or test.
- **Purpose (why needed):** Wire contract, shared utility, domain logic, or adapter aggregation.
- **Boundary (what it crosses):** Cross-workspace package, public subpath export, or intra-package module.

Do not infer runtime coupling solely from `package.json` `dependencies` vs. `devDependencies`: bundled builds may pull runtime assets through `devDependencies` (for example, `apps/server` bundles `@t3tools/web` without a runtime domain dependency on Web UI internals).

Separate package and directory responsibilities as follows:

- **Standalone protocol libraries** (`packages/effect-acp`, `packages/effect-codex-app-server`): Independent protocol implementations with zero dependencies on product packages (`@t3tools/*`).
- **Wire contracts** (`packages/contracts`): Zero internal workspace dependencies. Owns wire schemas and shared identifiers only; internal domain models and persistence models may define explicit translation boundaries without duplicating domain definitions.
- **Shared utilities** (`packages/shared`): Cross-package utilities, shared platform abstractions, and multi-app pure logic. Do not place single-domain logic here, and prohibit unrelated intra-package cross-domain imports.
- **Domain cores** (`packages/*-core`, `packages/ssh`, `packages/tailscale`): Domain-specific contracts and pure/shared foundations.
- **Adapters** (`packages/provider-*`, `packages/source-control-*`, `packages/secret-provider-*`, `packages/issue-tracker-*`): External protocol and service integrations.
- **Adapter registries / definitions** (`packages/*-definitions`): Composition and registration of adapter sets; depending on the adapters they aggregate is intentional.
- **Client runtime** (`packages/client-runtime`): Shared Web/Desktop/Mobile connection and client domain state; must not depend on `apps/*`.
- **Application shells** (`apps/server`, `apps/{web,desktop,mobile,marketing}`): Host/UI shells; client apps must not import `apps/server` internals.
- **Hosted services** (`infra/relay`, `infra/task-cache`): Deployed runtime services with their own application boundaries and deployment wiring. Compose their dependencies through public interfaces; keep service internals out of other applications' runtime dependencies.
- **Support & non-runtime areas** (`scripts/`, `evals/`, `oxlint-plugin-t3code/`, `packaging/`, `packages/*-testing`): Tooling, build, and test support only; never imported by production runtime code.

Apply these dependency constraints to runtime code, including module and public subpath imports:

- Domain cores depend on contracts, shared primitives, and explicit domain interfaces, never on concrete adapters, application shells, or client runtime implementations.
- Shared utilities must not depend on concrete domain implementations or application code. Shared domain logic retains an explicit owner; unrelated domains must not depend on one another for generic helpers.
- Adapters depend on public core, protocol, contract, and shared interfaces, not application internals or client runtime implementations. A registry or composition boundary may depend on the adapters it assembles.
- Client runtime and client apps must not import server-only implementations, even through shared package subpaths. Application and hosted-service composition may select concrete adapters through their public interfaces.
- Build and test dependencies do not authorize runtime coupling. Keep build artifact consumption and test fixtures at their corresponding boundaries.

Dependencies between packages of the same role are neither blanket-allowed nor blanket-forbidden; judge them by ownership and purpose. Distinguish adopted architectural patterns from historical leftovers before copying existing code.

## Settings ownership

Client preferences stay in the current client; environment defaults and project overrides stay
on their owning server. The web and desktop settings target is URL state, resolved against current
connections and project membership. An unavailable target must not fall back to another environment.
**All environments** is an explicit bulk edit of connected, loaded servers, not a durable global
default or a promise to synchronize offline or future environments. Project-group targets similarly
select known environment-local checkouts; the group itself does not store inherited defaults.

## Durable intent and side effects

Orchestration commands decide events without side effects, and persisted projections provide the authoritative view of current state once applied. The atomic transaction boundary is one individual command—not an entire turn, which spans multiple command transactions and asynchronous outbox effects over time. The [v2 orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts) serializes commands and decides events without performing provider or filesystem work.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events, persisted projections,
the accepted command receipt, and outbox effects in one database transaction. Subscribers receive
events after that commit. This keeps command retries idempotent and prevents a persisted projection
from getting ahead of the event log.

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) performs side effects
after intent has been recorded, then feeds results back into orchestration. A command acknowledgement
therefore means the intent committed, not that the provider, checkpoint, or other follow-up work
finished. Keep external I/O out of command decisions and the database transaction. Effects tied to
a lost provider process cannot simply replay; recovery retires them before admitting new work.

The event log only keeps what live readers need: about a day of history for reconnect replay and
command-id retries.
[ProjectionMaintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts) deletes
older events the projections cover, so projections cannot be rebuilt from the log. It keeps each
stream's newest event (high-water marks, stream versions, snapshot sequences), `thread.created`
(the legacy importer's marker), every `running` run update (Codex usage history reads the first
of each attempt), and prompt anchors that retained subagent rows reference. A client whose cursor
is below both its thread's newest event and the recorded pruned-through sequence missed pruned
events, so it resumes from a snapshot; an idle thread's cursor resumes without one. Resumes
recheck that sequence after reading the replay, since a pass can prune during the read. V2 command
receipts stay for idempotency: a retry older than the retained history is still deduplicated,
but its replay comes back without the pruned events. Receipts of imported legacy commands are
removed once their threads are imported.

Retained events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A provider turn ending and its follow-up work settling are separate milestones. Orchestration
records provider turn and run state independently from
[run finalization](../../apps/server/src/orchestration-v2/RunFinalizationService.ts). A late
checkpoint or diff must not extend the recorded provider duration or keep the client showing
provider work as active. PR discovery after completion also checks that the checkout still matches
the thread's non-default branch and that a newer run is not active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

A thread also gets one `repository` checkpoint scope per tracked Git folder it reaches, under its
root scope. A project can track dozens of repositories while a
turn touches a few, so these scopes are sparse: a turn costs one `git status` per repository, and
only a repository the turn changed gets a snapshot ref, a `checkpoint.captured` record and, the
first time, its `checkpoint-scope.created`. A missing record means the turn left the repository
alone, and a ref does not exist for every run ordinal.

A file rewind restores the thread's folder and every repository a discarded run changed, or none
of them: each folder is snapshotted first and put back if a later restore fails. A repository
with no checkpoint at the target returns to the baseline taken before its first later change,
which `repositoryRewindCheckpoint` picks; one whose earlier state was never snapshotted is left as
it is. Run ordinals are never reused, so the snapshots of discarded runs are deleted rather than
overwritten.

A worktree thread of a project that tracks Git folders works in a task folder: one directory under
the worktrees directory that holds the project folder and a worktree of each chosen repository at
the same relative places, all on the thread's branch. The record is keyed by that directory, not
by thread, because subagents, forks and reused worktrees share a path. Such a thread reaches only
those worktrees: a repository scope's `cwd` is the worktree and its `repositoryPath` the tracked
folder. A project folder that is not a repository root is never checked out; its entries are
linked, so they stay shared with the original. Its root checkpoints are `missing` by design, and
a file rewind there restores the repositories alone. `TaskFolders` owns every change to a task folder,
and removal keeps any checkout the single-worktree rules would keep.

Thread settlement is server-owned. The
[settlement service](../../apps/server/src/orchestration-v2/ThreadSettlementService.ts) evaluates PR
and inactivity settings without a connected client. Merge notifications invalidate cached PR state
and trigger a check. A merge outside T3, such as an agent running `gh pr merge`, sends no
notification, so the [PR sync reactor](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts)
re-reads a thread's open links when a run that ran a merge or close command ends. Each forge's
definition names its CLI's commands in `changeRequestCloseCommand`. The guarded
`thread.auto-settle` command rejects newer activity, explicit settlement overrides, and live or
blocked work. It records the activity timestamp for stable
sorting and detaches idle provider sessions. Clients render the persisted result; they do not
derive settlement from their own clocks or PR caches.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

V2 tests also drain the effect worker or await a specific persisted event or receipt. Test signals
are separate from the durable command receipts that make dispatch idempotent. Production behavior
must use persisted state and events, not test instrumentation or assumptions about elapsed time.

The Electron shell acquires `DesktopPreReadyPlatform.layer` synchronously before asynchronous
services. On Linux this sets the desktop-entry identity and global-shortcut portal flags before
Chromium initializes its portal connection. Setting the identity later in `DesktopAppIdentity`
is too late: Chromium caches the first registration, including failures. The identity must match
the installed entry managed by `DesktopLinuxUrlHandler`. Pre-ready setup also refreshes that entry's
`Exec` path before portal registration: AppImage updates can remove the previous executable, which
makes the old entry invalid even though its filename is correct. The later URL handler avoids
rewriting an identical entry while the portal may be reading it. On Wayland, Electron's synchronous
shortcut-registration result only confirms submission; it does not confirm desktop consent or
an active binding.

Native modules never load in the Electron main process on the startup path, and the two the
snapshot feature keeps are isolated: `@crowecawcaw/xa11y` runs only in forked Node-mode children
(`SnapShotAccessibilityWorker`, `RegionSnapShotWorker`) and a worker thread, and `ffi-rs` loads
lazily inside `WindowsForeground.ts` for a handful of Win32 calls. macOS window lookup shells out
to `osascript` instead of a native addon. A crash or stall in any of these must not take the app
down, so new native capability goes in a child with a deadline, not an `import` in main.

## Cross-cutting runtime policies

- **Errors, retries, cancellation, and recovery:** Use typed Effect errors at service boundaries; keep command retries idempotent via durable receipts; handle interruption and cancellation cleanly, isolate crashing native/external helpers in child processes with deadlines, and retire lost provider sessions during recovery before admitting new work.
- **External services and platform isolation:** Isolate provider protocols, forges, OS specifics, and hosted services behind adapters; keep core domain logic platform-agnostic.
- **Backward compatibility, migration, and deprecation:** Persisted events, SQLite schemas, and RPC contracts serve independently versioned clients and stored history. State explicit compatibility windows, migration or rollback paths, and removal criteria before deprecating fields or behaviors.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.

import * as NodeSqlite from "node:sqlite";

import {
  UnifiedAgentSessionError,
  type AgentSessionImportDiagnostic,
  type ExtendedAgentSessionSource,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { piHome, resolvePiSessionsDir } from "@t3tools/provider-pi/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  importPathComparisonKey,
  isSameImportDirectory,
  normalizeImportMessages,
} from "@t3tools/shared/importNormalizer.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseAntigravitySession } from "./antigravityImport.core.ts";
import { parseCursorStateDb, type CursorKvEntry } from "./cursorImport.core.ts";
import {
  parseExistingSourceTranscript,
  type ExistingAgentSessionSource,
} from "./existingSourcesImport.core.ts";
import { parseOpencodeSession } from "./opencodeImport.core.ts";
import {
  buildProjectInstructionsFromRules,
  type BuildProjectRulesResult,
  type ProjectRuleFileInput,
} from "./projectRulesImport.core.ts";

export interface ExtendedScannerRoots {
  readonly claudeDir?: string | undefined;
  readonly codexDir?: string | undefined;
  readonly piDir?: string | undefined;
  readonly cursorWorkspaceStorageDir?: string | undefined;
  readonly opencodeStorageDir?: string | undefined;
  readonly antigravityDir?: string | undefined;
}

export interface ScannedUnifiedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ScannedUnifiedThread {
  readonly source: ExtendedAgentSessionSource;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly normalizedWorkspacePath: string;
  readonly title: string;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: ReadonlyArray<ScannedUnifiedMessage>;
  readonly filePath: string;
}

export interface ExtendedScannerScanOptions {
  readonly roots?: ExtendedScannerRoots | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly sources?: ReadonlyArray<ExtendedAgentSessionSource> | undefined;
}

export interface ExtendedScannerScanOutput {
  readonly threads: ReadonlyArray<ScannedUnifiedThread>;
  readonly diagnostics: ReadonlyArray<AgentSessionImportDiagnostic>;
  readonly totalRecordsProcessed: number;
  readonly repairedTimestampCount: number;
}

export interface ExtendedProjectRulesScanOutput {
  readonly workspaceRoot: string;
  readonly ruleFiles: ReadonlyArray<ProjectRuleFileInput>;
  readonly result: BuildProjectRulesResult;
}

export class ExtendedAgentSessionScanner extends Context.Service<
  ExtendedAgentSessionScanner,
  {
    readonly scanSessions: (
      options?: ExtendedScannerScanOptions | undefined,
    ) => Effect.Effect<ExtendedScannerScanOutput, UnifiedAgentSessionError>;
    readonly scanProjectRules: (
      workspaceRoot: string,
    ) => Effect.Effect<ExtendedProjectRulesScanOutput, UnifiedAgentSessionError>;
    readonly readCursorSqliteEntries: (
      databasePath: string,
    ) => Effect.Effect<ReadonlyArray<CursorKvEntry>, UnifiedAgentSessionError>;
  }
>()("t3/project/importers/ExtendedAgentSessionScanner") {}

const ROOT_RULE_CANDIDATES = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  ".claude/CLAUDE.md",
  "GEMINI.md",
  ".gemini/GEMINI.md",
  ".cursorrules",
] as const;

/** Where each agent keeps its sessions on this machine, honoring the same overrides the agents read. */
export function resolveDefaultScannerRoots(input: {
  readonly homeDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly path: Path.Path;
}): ExtendedScannerRoots {
  const { homeDir, environment, platform, path } = input;
  const configured = (name: string, fallback: string) => {
    const value = environment[name]?.trim();
    return value ? path.resolve(expandHomePath(value, homeDir)) : fallback;
  };
  const absoluteOr = (name: string, fallback: string) => {
    const value = environment[name]?.trim();
    return value && path.isAbsolute(value) ? value : fallback;
  };
  const cursorUserDir =
    platform === "win32"
      ? path.join(absoluteOr("APPDATA", path.join(homeDir, "AppData", "Roaming")), "Cursor", "User")
      : platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Cursor", "User")
        : path.join(absoluteOr("XDG_CONFIG_HOME", path.join(homeDir, ".config")), "Cursor", "User");
  return {
    claudeDir: path.join(
      configured("CLAUDE_CONFIG_DIR", path.join(homeDir, ".claude")),
      "projects",
    ),
    // The Codex home, not `sessions/`: the scan reads `session_index.jsonl` from this root.
    codexDir: configured("CODEX_HOME", path.join(homeDir, ".codex")),
    piDir: resolvePiSessionsDir(environment, piHome(environment, homeDir, platform), path),
    cursorWorkspaceStorageDir: path.join(cursorUserDir, "workspaceStorage"),
    opencodeStorageDir: path.join(
      absoluteOr("XDG_DATA_HOME", path.join(homeDir, ".local", "share")),
      "opencode",
      "storage",
    ),
    antigravityDir: path.join(
      configured("GEMINI_HOME", path.join(homeDir, ".gemini")),
      "antigravity",
    ),
  };
}

const CODEX_ROLLOUT_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function stripExtension(filename: string, ext: string): string {
  return filename.toLowerCase().endsWith(ext.toLowerCase())
    ? filename.slice(0, filename.length - ext.length)
    : filename;
}

const decodeJsonId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
);

function extractJsonObjectId(jsonText: string, fallbackId: string): string {
  const decoded = decodeJsonId(jsonText);
  if (Option.isNone(decoded)) return fallbackId;
  const trimmed = decoded.value.id.trim();
  return trimmed.length > 0 ? trimmed : fallbackId;
}

function parseCodexSessionIndex(contents: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of contents.replaceAll("\r\n", "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).id === "string" &&
        typeof (parsed as Record<string, unknown>).thread_name === "string"
      ) {
        const id = ((parsed as Record<string, unknown>).id as string).trim();
        const name = ((parsed as Record<string, unknown>).thread_name as string).trim();
        if (id.length > 0 && name.length > 0) {
          map.set(id, name);
        }
      }
    } catch {
      // Ignore malformed session index lines.
    }
  }
  return map;
}

function readCursorDatabaseSync(databasePath: string): ReadonlyArray<CursorKvEntry> {
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const tablesStmt = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ItemTable', 'cursorDiskKV')",
    );
    const tableRows = tablesStmt.all() as ReadonlyArray<Record<string, unknown>>;
    const existingTables = new Set(
      tableRows
        .map((row) => (typeof row.name === "string" ? row.name : ""))
        .filter((name) => name.length > 0),
    );

    const entries: CursorKvEntry[] = [];
    const decoder = new TextDecoder();

    for (const tableName of ["ItemTable", "cursorDiskKV"] as const) {
      if (!existingTables.has(tableName)) continue;
      const stmt = db.prepare(`SELECT key, value FROM ${tableName}`);
      const rows = stmt.all() as ReadonlyArray<Record<string, unknown>>;
      for (const row of rows) {
        if (typeof row.key !== "string" || row.key.trim().length === 0) continue;
        const rawVal = row.value;
        const value =
          typeof rawVal === "string"
            ? rawVal
            : rawVal instanceof Uint8Array
              ? decoder.decode(rawVal)
              : rawVal;
        entries.push({ key: row.key, value });
      }
    }
    return entries;
  } finally {
    db.close();
  }
}

/** @public */
export const makeWithRoots = Effect.fn("ExtendedAgentSessionScanner.make")(function* (
  defaultRoots?: ExtendedScannerRoots | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const pathExists = (targetPath: string): Effect.Effect<boolean> =>
    fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => false));

  const readTextIfExists = (targetPath: string): Effect.Effect<string | null> =>
    fileSystem.readFileString(targetPath).pipe(Effect.orElseSucceed(() => null));

  const listFilesRecursive: (
    dirPath: string,
    predicate: (filePath: string) => boolean,
    maxDepth?: number,
  ) => Effect.Effect<ReadonlyArray<string>> = Effect.fn(
    "ExtendedAgentSessionScanner.listFilesRecursive",
  )(function* (dirPath: string, predicate: (filePath: string) => boolean, maxDepth = 6) {
    if (maxDepth < 0 || !(yield* pathExists(dirPath))) return [];
    const entries = yield* fileSystem
      .readDirectory(dirPath)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const sortedEntries = [...entries].sort((a, b) => a.localeCompare(b));
    const collected: string[] = [];

    for (const entryName of sortedEntries) {
      const fullPath = path.join(dirPath, entryName);
      const stat = yield* fileSystem.stat(fullPath).pipe(Effect.orElseSucceed(() => null));
      if (stat === null) continue;
      if (stat.type === "Directory") {
        const nested = yield* listFilesRecursive(fullPath, predicate, maxDepth - 1);
        collected.push(...nested);
      } else if (stat.type === "File" && predicate(fullPath)) {
        collected.push(fullPath);
      }
    }
    return collected;
  });

  const readCursorSqliteEntries: ExtendedAgentSessionScanner["Service"]["readCursorSqliteEntries"] =
    Effect.fn("ExtendedAgentSessionScanner.readCursorSqliteEntries")(function* (databasePath) {
      return yield* Effect.try({
        try: () => readCursorDatabaseSync(databasePath),
        catch: (cause) =>
          new UnifiedAgentSessionError({
            operation: "read-sqlite",
            detail: `Failed to read Cursor state database at ${databasePath}`,
            cause,
          }),
      });
    });

  const scanSessions: ExtendedAgentSessionScanner["Service"]["scanSessions"] = Effect.fn(
    "ExtendedAgentSessionScanner.scanSessions",
  )(function* (options) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const configuredRoots: ExtendedScannerRoots = {
      ...defaultRoots,
      ...options?.roots,
    };
    // Configured roots replace the machine's defaults as a whole, so a scan of given folders
    // never also reads this user's real agent homes.
    const roots = Object.values(configuredRoots).some((root) => root !== undefined)
      ? configuredRoots
      : resolveDefaultScannerRoots({
          homeDir: yield* HostProcess.HomeDirectory,
          environment: yield* HostProcess.Environment,
          platform: yield* HostProcess.Platform,
          path,
        });
    const enabledSources = options?.sources !== undefined ? new Set(options.sources) : null;
    const isSourceEnabled = (source: ExtendedAgentSessionSource): boolean =>
      enabledSources === null || enabledSources.has(source);
    const matchesTargetWorkspace = (candidatePath: string | null): candidatePath is string => {
      if (candidatePath === null || candidatePath.trim().length === 0) return false;
      if (options?.workspaceRoot === undefined) return true;
      return isSameImportDirectory(candidatePath, options.workspaceRoot);
    };

    const threads: ScannedUnifiedThread[] = [];
    const diagnostics: AgentSessionImportDiagnostic[] = [];
    let totalRecordsProcessed = 0;
    let repairedTimestampCount = 0;

    const scanExistingJsonlSource = Effect.fn(
      "ExtendedAgentSessionScanner.scanExistingJsonlSource",
    )(function* (source: ExistingAgentSessionSource, rootDir: string | undefined) {
      if (!isSourceEnabled(source) || rootDir === undefined) return;
      if (!(yield* pathExists(rootDir))) return;

      const codexIndexText =
        source === "codex"
          ? yield* readTextIfExists(path.join(rootDir, "session_index.jsonl"))
          : null;
      const codexNames =
        codexIndexText !== null
          ? parseCodexSessionIndex(codexIndexText)
          : new Map<string, string>();

      const files = yield* listFilesRecursive(rootDir, (filePath) => {
        const base = path.basename(filePath).toLowerCase();
        if (!base.endsWith(".jsonl")) return false;
        if (source === "codex" && (base === "session_index.jsonl" || base === "history.jsonl")) {
          return false;
        }
        return true;
      });

      for (const filePath of files) {
        const contents = yield* readTextIfExists(filePath);
        if (contents === null) continue;
        const fallbackId = stripExtension(path.basename(filePath), ".jsonl");
        const parsed = parseExistingSourceTranscript({
          source,
          jsonl: contents,
          fallbackSessionId: fallbackId,
          fallbackTimestamp: nowIso,
          // Codex names rollouts `rollout-<time>-<uuid>.jsonl`; the index keys by the uuid.
          codexThreadName:
            codexNames.get(fallbackId) ??
            codexNames.get(CODEX_ROLLOUT_ID_PATTERN.exec(fallbackId)?.[1] ?? ""),
        });

        for (const diag of parsed.diagnostics) {
          diagnostics.push({
            source,
            scope: "transcript",
            reason: diag.reason,
            detail: diag.detail,
            filePath,
            line: diag.line,
          });
        }

        if (parsed.thread === null) continue;
        const workspacePath = parsed.thread.workspacePath;
        if (!matchesTargetWorkspace(workspacePath)) continue;

        const normalized = normalizeImportMessages(parsed.thread.messages, {
          fallbackCreatedAt: parsed.thread.createdAt,
        });
        totalRecordsProcessed += normalized.summary.totalRecords;
        repairedTimestampCount += normalized.summary.repairedTimestampCount;

        if (normalized.messages.length === 0) continue;

        threads.push({
          source,
          sessionId: parsed.thread.sessionId,
          workspacePath,
          normalizedWorkspacePath: importPathComparisonKey(workspacePath),
          title: parsed.thread.title,
          model: parsed.thread.model,
          createdAt: normalized.messages[0]?.createdAt ?? parsed.thread.createdAt,
          updatedAt: normalized.messages.at(-1)?.createdAt ?? parsed.thread.updatedAt,
          messages: normalized.messages,
          filePath,
        });
      }
    });

    yield* scanExistingJsonlSource("claudeAgent", roots.claudeDir);
    yield* scanExistingJsonlSource("codex", roots.codexDir);
    yield* scanExistingJsonlSource("pi", roots.piDir);

    if (isSourceEnabled("cursor") && roots.cursorWorkspaceStorageDir !== undefined) {
      const storageRoot = roots.cursorWorkspaceStorageDir;
      if (yield* pathExists(storageRoot)) {
        const vscdbFiles = yield* listFilesRecursive(
          storageRoot,
          (filePath) => path.basename(filePath).toLowerCase() === "state.vscdb",
          3,
        );

        for (const vscdbPath of vscdbFiles) {
          const workspaceDir = path.dirname(vscdbPath);
          const workspaceJsonPath = path.join(workspaceDir, "workspace.json");
          const workspaceJsonText = yield* readTextIfExists(workspaceJsonPath);

          const kvEntries = yield* readCursorSqliteEntries(vscdbPath).pipe(
            Effect.catch((error) => {
              diagnostics.push({
                source: "cursor",
                scope: "sqlite",
                reason: "invalid_sqlite",
                detail: error.detail,
                filePath: vscdbPath,
              });
              return Effect.succeed(null);
            }),
          );
          if (kvEntries === null) continue;

          const parsed = parseCursorStateDb({
            workspaceJson: workspaceJsonText ?? undefined,
            entries: kvEntries,
            fallbackTimestamp: nowIso,
          });

          for (const diag of parsed.diagnostics) {
            diagnostics.push({
              source: "cursor",
              scope: diag.key,
              reason: diag.reason,
              detail: diag.detail,
              filePath: vscdbPath,
            });
          }

          for (const thread of parsed.threads) {
            const workspacePath = thread.workspacePath ?? options?.workspaceRoot ?? null;
            if (!matchesTargetWorkspace(workspacePath)) continue;

            const normalized = normalizeImportMessages(thread.messages, {
              fallbackCreatedAt: thread.createdAt,
            });
            totalRecordsProcessed += normalized.summary.totalRecords;
            repairedTimestampCount += normalized.summary.repairedTimestampCount;
            if (normalized.messages.length === 0) continue;

            threads.push({
              source: "cursor",
              sessionId: thread.sessionId,
              workspacePath,
              normalizedWorkspacePath: importPathComparisonKey(workspacePath),
              title: thread.title,
              model: thread.model,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              messages: normalized.messages,
              filePath: vscdbPath,
            });
          }
        }
      }
    }

    if (isSourceEnabled("opencode") && roots.opencodeStorageDir !== undefined) {
      const opencodeRoot = roots.opencodeStorageDir;
      if (yield* pathExists(opencodeRoot)) {
        const sessionDir = path.join(opencodeRoot, "session");
        const messageRootDir = path.join(opencodeRoot, "message");
        const partRootDir = path.join(opencodeRoot, "part");

        const sessionFiles = (yield* pathExists(sessionDir))
          ? yield* listFilesRecursive(
              sessionDir,
              (filePath) => filePath.toLowerCase().endsWith(".json"),
              4,
            )
          : yield* listFilesRecursive(
              opencodeRoot,
              (filePath) => filePath.toLowerCase().endsWith(".json"),
              2,
            );

        for (const sessionFile of sessionFiles) {
          const sessionText = yield* readTextIfExists(sessionFile);
          if (sessionText === null) continue;
          const fallbackId = stripExtension(path.basename(sessionFile), ".json");

          const sessionIdCandidate = extractJsonObjectId(sessionText, fallbackId);

          const messageFiles = (yield* pathExists(path.join(messageRootDir, sessionIdCandidate)))
            ? yield* listFilesRecursive(
                path.join(messageRootDir, sessionIdCandidate),
                (filePath) => filePath.toLowerCase().endsWith(".json"),
                2,
              )
            : [];

          const messageTexts: string[] = [];
          const partTexts: string[] = [];

          for (const msgFile of messageFiles) {
            const msgText = yield* readTextIfExists(msgFile);
            if (msgText === null) continue;
            messageTexts.push(msgText);

            const messageIdCandidate = extractJsonObjectId(
              msgText,
              stripExtension(path.basename(msgFile), ".json"),
            );

            const msgPartDir = path.join(partRootDir, messageIdCandidate);
            if (yield* pathExists(msgPartDir)) {
              const partFiles = yield* listFilesRecursive(
                msgPartDir,
                (filePath) => filePath.toLowerCase().endsWith(".json"),
                2,
              );
              for (const partFile of partFiles) {
                const pText = yield* readTextIfExists(partFile);
                if (pText !== null) partTexts.push(pText);
              }
            }
          }

          const parsed = parseOpencodeSession({
            session: sessionText,
            messages: messageTexts,
            parts: partTexts,
            fallbackSessionId: fallbackId,
            fallbackTimestamp: nowIso,
          });

          for (const diag of parsed.diagnostics) {
            diagnostics.push({
              source: "opencode",
              scope: diag.scope,
              reason: diag.reason,
              detail: diag.detail,
              filePath: sessionFile,
            });
          }

          if (parsed.thread === null) continue;
          const workspacePath = parsed.thread.directory ?? options?.workspaceRoot ?? null;
          if (!matchesTargetWorkspace(workspacePath)) continue;

          const normalized = normalizeImportMessages(parsed.thread.messages, {
            fallbackCreatedAt: parsed.thread.createdAt,
          });
          totalRecordsProcessed += normalized.summary.totalRecords;
          repairedTimestampCount += normalized.summary.repairedTimestampCount;
          if (normalized.messages.length === 0) continue;

          threads.push({
            source: "opencode",
            sessionId: parsed.thread.sessionId,
            workspacePath,
            normalizedWorkspacePath: importPathComparisonKey(workspacePath),
            title: parsed.thread.title,
            model: parsed.thread.model,
            createdAt: parsed.thread.createdAt,
            updatedAt: parsed.thread.updatedAt,
            messages: normalized.messages,
            filePath: sessionFile,
          });
        }
      }
    }

    if (isSourceEnabled("antigravity") && roots.antigravityDir !== undefined) {
      const agRoot = roots.antigravityDir;
      if (yield* pathExists(agRoot)) {
        const jsonlFiles = yield* listFilesRecursive(
          agRoot,
          (filePath) => filePath.toLowerCase().endsWith(".jsonl"),
          5,
        );

        for (const jsonlFile of jsonlFiles) {
          const jsonlText = yield* readTextIfExists(jsonlFile);
          if (jsonlText === null) continue;

          const dir = path.dirname(jsonlFile);
          const baseNoExt = stripExtension(path.basename(jsonlFile), ".jsonl");
          const siblingMeta =
            (yield* readTextIfExists(path.join(dir, `${baseNoExt}.meta.json`))) ??
            (yield* readTextIfExists(path.join(dir, "metadata.json"))) ??
            (yield* readTextIfExists(path.join(dir, "session.json")));

          const fallbackId =
            baseNoExt === "transcript" || baseNoExt === "transcript_full"
              ? path.basename(dir)
              : baseNoExt;

          const parsed = parseAntigravitySession({
            jsonl: jsonlText,
            metadata: siblingMeta ?? undefined,
            fallbackSessionId: fallbackId,
            fallbackTimestamp: nowIso,
          });

          for (const diag of parsed.diagnostics) {
            diagnostics.push({
              source: "antigravity",
              scope: "transcript",
              reason: diag.reason,
              detail: diag.detail,
              filePath: jsonlFile,
              line: diag.line,
            });
          }

          if (parsed.thread === null) continue;
          const workspacePath = parsed.thread.workspacePath ?? options?.workspaceRoot ?? null;
          if (!matchesTargetWorkspace(workspacePath)) continue;

          const normalized = normalizeImportMessages(parsed.thread.messages, {
            fallbackCreatedAt: parsed.thread.createdAt,
          });
          totalRecordsProcessed += normalized.summary.totalRecords;
          repairedTimestampCount += normalized.summary.repairedTimestampCount;
          if (normalized.messages.length === 0) continue;

          threads.push({
            source: "antigravity",
            sessionId: parsed.thread.sessionId,
            workspacePath,
            normalizedWorkspacePath: importPathComparisonKey(workspacePath),
            title: parsed.thread.title,
            model: parsed.thread.model,
            createdAt: parsed.thread.createdAt,
            updatedAt: parsed.thread.updatedAt,
            messages: normalized.messages,
            filePath: jsonlFile,
          });
        }
      }
    }

    return {
      threads,
      diagnostics,
      totalRecordsProcessed,
      repairedTimestampCount,
    };
  });

  const scanProjectRules: ExtendedAgentSessionScanner["Service"]["scanProjectRules"] = Effect.fn(
    "ExtendedAgentSessionScanner.scanProjectRules",
  )(function* (workspaceRoot) {
    const ruleFiles: ProjectRuleFileInput[] = [];
    const seenRelativePaths = new Set<string>();

    const addRuleIfPresent = Effect.fn("ExtendedAgentSessionScanner.addRuleIfPresent")(function* (
      relativePath: string,
    ) {
      const normalizedRel = relativePath.replaceAll("\\", "/");
      if (seenRelativePaths.has(normalizedRel)) return;
      const fullPath = path.join(workspaceRoot, relativePath);
      const content = yield* readTextIfExists(fullPath);
      if (content === null) return;
      seenRelativePaths.add(normalizedRel);
      ruleFiles.push({ path: normalizedRel, content });
    });

    for (const candidateRel of ROOT_RULE_CANDIDATES) {
      yield* addRuleIfPresent(candidateRel);
    }

    const geminiDir = path.join(workspaceRoot, ".gemini");
    if (yield* pathExists(geminiDir)) {
      const geminiFiles = yield* listFilesRecursive(
        geminiDir,
        (filePath) => {
          const lower = filePath.toLowerCase();
          return lower.endsWith(".md") || lower.endsWith(".mdc");
        },
        2,
      );
      for (const fullFile of geminiFiles) {
        const rel = path.relative(workspaceRoot, fullFile).replaceAll("\\", "/");
        yield* addRuleIfPresent(rel);
      }
    }

    const cursorRulesDir = path.join(workspaceRoot, ".cursor", "rules");
    if (yield* pathExists(cursorRulesDir)) {
      const cursorRuleFiles = yield* listFilesRecursive(
        cursorRulesDir,
        (filePath) => {
          const lower = filePath.toLowerCase();
          return lower.endsWith(".mdc") || lower.endsWith(".md");
        },
        3,
      );
      for (const fullFile of cursorRuleFiles) {
        const rel = path.relative(workspaceRoot, fullFile).replaceAll("\\", "/");
        yield* addRuleIfPresent(rel);
      }
    }

    const result = buildProjectInstructionsFromRules(ruleFiles);
    return {
      workspaceRoot,
      ruleFiles,
      result,
    };
  });

  return {
    scanSessions,
    scanProjectRules,
    readCursorSqliteEntries,
  };
});

/** @public */
export const make = makeWithRoots();

export const layer = (defaultRoots?: ExtendedScannerRoots | undefined) =>
  Layer.effect(ExtendedAgentSessionScanner, makeWithRoots(defaultRoots));

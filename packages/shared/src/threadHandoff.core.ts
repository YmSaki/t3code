import { utf8ByteLength } from "./workerBrief.core.ts";

const TOOL_OUTPUT_MAX_LINES = 80;
const TOOL_OUTPUT_MAX_BYTES = 8_000;
const TOOL_LABEL_MAX_BYTES = 2_000;
const CHANGED_FILES_LIMIT = 50;
const RECENT_ERRORS_LIMIT = 5;
const RECENT_ERROR_MAX_BYTES = 500;
const TURN_SEPARATOR = "\n\n";

export type ThreadHandoffEntry =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly label: string;
      readonly output?: string | undefined;
      readonly exitCode?: number | undefined;
    }
  | { readonly kind: "error"; readonly message: string };

export interface ThreadHandoffBuildInput {
  readonly source: {
    readonly threadId: string;
    readonly title: string;
    readonly model: string;
    readonly branch: string | null;
    readonly workspaceRoot: string | null;
    readonly changedFiles: ReadonlyArray<string>;
  };
  readonly entries: ReadonlyArray<ThreadHandoffEntry>;
  /** `compact` drops tool output bodies; messages stay verbatim in both modes. */
  readonly mode: "raw" | "compact";
  /** Oldest turns are dropped to fit; the newest turn is always kept whole. */
  readonly maxBytes: number;
}

export interface ThreadHandoffContext {
  readonly text: string;
  readonly bytes: number;
  readonly turnCount: number;
  readonly omittedTurnCount: number;
  readonly truncatedToolOutputCount: number;
  /** The text exceeds `maxBytes` even with only the newest turn kept. */
  readonly overBudget: boolean;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const isContinuationByte = (byte: number | undefined) =>
  byte !== undefined && (byte & 0xc0) === 0x80;

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end])) end--;
  return utf8Decoder.decode(bytes.subarray(0, end));
}

function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && isContinuationByte(bytes[start])) start++;
  return utf8Decoder.decode(bytes.subarray(start));
}

const lineCount = (value: string) => (value === "" ? 0 : value.split("\n").length);

function truncateToolOutput(output: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const totalBytes = utf8ByteLength(output);
  const lines = output.split("\n");
  if (lines.length <= TOOL_OUTPUT_MAX_LINES && totalBytes <= TOOL_OUTPUT_MAX_BYTES) {
    return { text: output, truncated: false };
  }
  const half = TOOL_OUTPUT_MAX_LINES / 2;
  const byLines = lines.length > TOOL_OUTPUT_MAX_LINES;
  const head = utf8Prefix(
    byLines ? lines.slice(0, half).join("\n") : output,
    TOOL_OUTPUT_MAX_BYTES / 2,
  );
  const tail = utf8Suffix(
    byLines ? lines.slice(-half).join("\n") : output,
    TOOL_OUTPUT_MAX_BYTES / 2,
  );
  const omittedBytes = totalBytes - utf8ByteLength(head) - utf8ByteLength(tail);
  const omittedLines = Math.max(0, lines.length - lineCount(head) - lineCount(tail));
  return {
    text: `${head}\n[... truncated ${omittedLines} lines, ${omittedBytes} bytes ...]\n${tail}`,
    truncated: true,
  };
}

function truncateLabel(label: string): string {
  const bytes = utf8ByteLength(label);
  if (bytes <= TOOL_LABEL_MAX_BYTES) return label;
  const head = utf8Prefix(label, TOOL_LABEL_MAX_BYTES);
  return `${head}\n[... truncated ${bytes - utf8ByteLength(head)} bytes ...]`;
}

const singleLine = (value: string) => value.replaceAll(/\s*\n\s*/g, " ");

function fenced(content: string): string {
  const longestRun = (content.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${content}\n${fence}`;
}

const exitSuffix = (exitCode: number | undefined) =>
  exitCode === undefined ? "" : ` (exit ${exitCode})`;

function renderEntry(
  entry: ThreadHandoffEntry,
  mode: ThreadHandoffBuildInput["mode"],
): { readonly text: string; readonly truncated: boolean } {
  switch (entry.kind) {
    case "user":
      return { text: `**User:**\n${entry.text}`, truncated: false };
    case "assistant":
      return { text: `**Assistant:**\n${entry.text}`, truncated: false };
    case "error":
      return { text: `**Error:** ${entry.message}`, truncated: false };
    case "tool": {
      const heading = `**Tool${exitSuffix(entry.exitCode)}:**\n${fenced(truncateLabel(entry.label))}`;
      if (mode === "compact" || entry.output === undefined || entry.output.trim() === "") {
        return { text: heading, truncated: false };
      }
      const output = truncateToolOutput(entry.output);
      return { text: `${heading}\nOutput:\n${fenced(output.text)}`, truncated: output.truncated };
    }
  }
}

function groupTurns(
  entries: ReadonlyArray<ThreadHandoffEntry>,
): ReadonlyArray<ReadonlyArray<ThreadHandoffEntry>> {
  const turns: Array<Array<ThreadHandoffEntry>> = [];
  for (const entry of entries) {
    const current = turns.at(-1);
    if (current === undefined || entry.kind === "user") turns.push([entry]);
    else current.push(entry);
  }
  return turns;
}

function recentErrors(entries: ReadonlyArray<ThreadHandoffEntry>): ReadonlyArray<string> {
  const errors: Array<string> = [];
  for (const entry of entries) {
    if (entry.kind === "error") errors.push(entry.message);
    else if (entry.kind === "tool" && entry.exitCode !== undefined && entry.exitCode !== 0) {
      const label = utf8Prefix(singleLine(entry.label), RECENT_ERROR_MAX_BYTES);
      errors.push(`\`${label}\` exited with ${entry.exitCode}`);
    }
  }
  return errors
    .slice(-RECENT_ERRORS_LIMIT)
    .map((error) => utf8Prefix(singleLine(error), RECENT_ERROR_MAX_BYTES));
}

function renderHeader(
  input: ThreadHandoffBuildInput,
  errors: ReadonlyArray<string>,
  turnCount: number,
  omittedTurnCount: number,
): string {
  const { source } = input;
  const files = source.changedFiles.slice(0, CHANGED_FILES_LIMIT).map(singleLine);
  const moreFiles = source.changedFiles.length - files.length;
  const changedFiles =
    files.length === 0
      ? "none recorded"
      : `${files.join(", ")}${moreFiles > 0 ? ` (+${moreFiles} more)` : ""}`;
  const errorLines =
    errors.length === 0
      ? " none recorded"
      : `\n${errors.map((error) => `  - ${error}`).join("\n")}`;
  const omitted =
    omittedTurnCount === 0
      ? ""
      : `; the ${omittedTurnCount} oldest turn${omittedTurnCount === 1 ? " was" : "s were"} omitted to fit ${input.maxBytes} bytes`;
  return [
    "# Thread handoff",
    "",
    `You are continuing work started in another thread. Below is its transcript: user and assistant messages are verbatim, and tool output is ${input.mode === "compact" ? "left out" : "truncated where marked"}. Pick up from the latest user request.`,
    "",
    `- Source thread: ${singleLine(source.title)} (${source.threadId})`,
    `- Source model: ${source.model}`,
    `- Branch: ${source.branch ?? "none"}`,
    `- Workspace root: ${source.workspaceRoot ?? "unknown"}`,
    `- Changed files: ${changedFiles}`,
    `- Recent errors:${errorLines}`,
    `- Transcript: ${turnCount - omittedTurnCount} of ${turnCount} turns, ${input.mode} mode${omitted}`,
  ].join("\n");
}

export function buildThreadHandoffContext(input: ThreadHandoffBuildInput): ThreadHandoffContext {
  const errors = recentErrors(input.entries);
  const groupedTurns = groupTurns(input.entries);
  const turns = groupedTurns.map((turn, index) => {
    const rendered = turn.map((entry) => renderEntry(entry, input.mode));
    const text = [`## Turn ${index + 1}`, ...rendered.map((entry) => entry.text)].join("\n\n");
    return {
      text,
      bytes: utf8ByteLength(text) + TURN_SEPARATOR.length,
      truncatedToolOutputs: rendered.filter((entry) => entry.truncated).length,
    };
  });
  // keptBytes[i] is the size of turns i..end, so each candidate cut costs one header render.
  const keptBytes = Array.from({ length: turns.length + 1 }, () => 0);
  for (let index = turns.length - 1; index >= 0; index--) {
    keptBytes[index] = keptBytes[index + 1]! + turns[index]!.bytes;
  }
  const lastCut = Math.max(0, turns.length - 1);
  let cut = 0;
  let header = renderHeader(input, errors, turns.length, 0);
  while (cut < lastCut && utf8ByteLength(header) + keptBytes[cut]! > input.maxBytes) {
    cut++;
    header = renderHeader(input, errors, turns.length, cut);
  }
  if (
    turns.length > 0 &&
    cut === lastCut &&
    input.mode === "raw" &&
    utf8ByteLength(header) + keptBytes[cut]! > input.maxBytes
  ) {
    const latestEntries = groupedTurns[lastCut]!;
    const rendered = latestEntries.map((entry) => renderEntry(entry, "raw"));
    const headerBytes = utf8ByteLength(header);
    for (let index = 0; index < latestEntries.length; index++) {
      const entry = latestEntries[index]!;
      if (entry.kind !== "tool" || entry.output === undefined || entry.output.trim() === "") {
        continue;
      }
      rendered[index] = { text: renderEntry(entry, "compact").text, truncated: true };
      const text = [`## Turn ${lastCut + 1}`, ...rendered.map((item) => item.text)].join("\n\n");
      const turnBytes = utf8ByteLength(text) + TURN_SEPARATOR.length;
      turns[lastCut] = {
        text,
        bytes: turnBytes,
        truncatedToolOutputs: rendered.filter((item) => item.truncated).length,
      };
      if (headerBytes + turnBytes <= input.maxBytes) break;
    }
  }
  const kept = turns.slice(cut);
  const text = [header, ...kept.map((turn) => turn.text)].join(TURN_SEPARATOR);
  const bytes = utf8ByteLength(text);
  return {
    text,
    bytes,
    turnCount: turns.length,
    omittedTurnCount: cut,
    truncatedToolOutputCount: kept.reduce((sum, turn) => sum + turn.truncatedToolOutputs, 0),
    overBudget: bytes > input.maxBytes,
  };
}

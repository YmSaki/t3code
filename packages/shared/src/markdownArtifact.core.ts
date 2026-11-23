export type MarkdownTaskCheckbox = {
  readonly index: number;
  readonly line: number;
  readonly checked: boolean;
  readonly text: string;
};

export type MarkdownToggleResult =
  | { readonly ok: true; readonly markdown: string; readonly checked: boolean }
  | { readonly ok: false; readonly reason: "index_out_of_range" };

export interface MarkdownLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface MarkdownLineComment extends MarkdownLineRange {
  readonly comment: string;
}

export interface MarkdownLineSelection {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface MarkdownRevisionPromptInput {
  readonly title: string;
  readonly markdown: string;
  readonly comments: ReadonlyArray<MarkdownLineComment>;
  readonly artifactId?: string;
}

export interface UnifiedDiffOptions {
  readonly oldLabel?: string;
  readonly newLabel?: string;
  readonly contextLines?: number;
}

interface ScannedLine {
  readonly text: string;
  readonly start: number;
  readonly inFence: boolean;
}

const TASK_ITEM_PATTERN = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\][ \t]|\]$)/;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MAX_DIFF_CELLS = 4_000_000;

function scanLines(markdown: string): ReadonlyArray<ScannedLine> {
  const lines: Array<ScannedLine> = [];
  let offset = 0;
  let fence: { readonly char: string; readonly length: number } | null = null;

  while (offset < markdown.length || lines.length === 0) {
    let end = offset;
    while (end < markdown.length && markdown[end] !== "\n" && markdown[end] !== "\r") end += 1;
    const text = markdown.slice(offset, end);
    let inFence = fence !== null;

    if (fence === null) {
      const open = FENCE_OPEN_PATTERN.exec(text);
      const marker = open?.[1];
      if (marker !== undefined && !(marker.startsWith("`") && (open?.[2] ?? "").includes("`"))) {
        fence = { char: marker[0] ?? "`", length: marker.length };
        inFence = true;
      }
    } else {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text);
      const marker = close?.[1];
      if (marker !== undefined && marker.startsWith(fence.char) && marker.length >= fence.length) {
        fence = null;
      }
    }

    lines.push({ text, start: offset, inFence });
    if (end >= markdown.length) break;
    offset = markdown[end] === "\r" && markdown[end + 1] === "\n" ? end + 2 : end + 1;
  }
  return lines;
}

export function listTaskCheckboxes(markdown: string): ReadonlyArray<MarkdownTaskCheckbox> {
  const checkboxes: Array<MarkdownTaskCheckbox> = [];
  scanLines(markdown).forEach((line, lineIndex) => {
    if (line.inFence) return;
    const match = TASK_ITEM_PATTERN.exec(line.text);
    if (!match) return;
    checkboxes.push({
      index: checkboxes.length,
      line: lineIndex + 1,
      checked: match[2] !== " ",
      text: line.text.slice(match[0].length).trim(),
    });
  });
  return checkboxes;
}

/** `index` counts task items in document order, skipping those inside code fences. */
export function toggleTaskCheckbox(
  markdown: string,
  index: number,
  checked?: boolean,
): MarkdownToggleResult {
  if (!Number.isInteger(index) || index < 0) return { ok: false, reason: "index_out_of_range" };
  let seen = 0;
  for (const line of scanLines(markdown)) {
    if (line.inFence) continue;
    const match = TASK_ITEM_PATTERN.exec(line.text);
    if (!match) continue;
    if (seen === index) {
      const next = checked ?? match[2] === " ";
      const position = line.start + (match[1]?.length ?? 0);
      return {
        ok: true,
        checked: next,
        markdown: `${markdown.slice(0, position)}${next ? "x" : " "}${markdown.slice(position + 1)}`,
      };
    }
    seen += 1;
  }
  return { ok: false, reason: "index_out_of_range" };
}

export function normalizeLineRange(
  markdown: string,
  range: MarkdownLineRange,
): MarkdownLineRange | null {
  const total = scanLines(markdown).length;
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) return null;
  const startLine = Math.min(range.startLine, range.endLine);
  const endLine = Math.max(range.startLine, range.endLine);
  if (startLine > total || endLine < 1) return null;
  return { startLine: Math.max(1, startLine), endLine: Math.min(total, endLine) };
}

export function extractLineSelection(
  markdown: string,
  range: MarkdownLineRange,
): MarkdownLineSelection | null {
  const normalized = normalizeLineRange(markdown, range);
  if (normalized === null) return null;
  const lines = scanLines(markdown);
  return {
    ...normalized,
    text: lines
      .slice(normalized.startLine - 1, normalized.endLine)
      .map((line) => line.text)
      .join("\n"),
  };
}

function fenceFor(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

function formatRange(range: MarkdownLineRange): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}-${range.endLine}`;
}

/** Comments whose range falls outside the document are dropped; the rest are listed in document order. */
export function buildMarkdownRevisionPrompt(input: MarkdownRevisionPromptInput): string | null {
  const resolved = input.comments.flatMap((entry) => {
    const comment = entry.comment.trim();
    const selection = comment === "" ? null : extractLineSelection(input.markdown, entry);
    return selection === null ? [] : [{ selection, comment }];
  });
  if (resolved.length === 0) return null;
  resolved.sort((left, right) => left.selection.startLine - right.selection.startLine);

  const target =
    input.artifactId === undefined
      ? `the markdown artifact "${input.title}"`
      : `the markdown artifact "${input.title}" (id: ${input.artifactId})`;
  const sections = resolved.map(({ selection, comment }, position) => {
    const fence = fenceFor(selection.text);
    return [
      `${position + 1}. ${formatRange(selection)}`,
      `${fence}markdown`,
      selection.text,
      fence,
      `Request: ${comment}`,
    ].join("\n");
  });

  return [
    `Revise ${target} to address each of the review comments below.`,
    "Each comment quotes the selected lines of the current version. Keep everything the comments do not mention unchanged, then save the result as a new version of the artifact.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ]
    .join("\n")
    .trimEnd();
}

function splitDiffLines(text: string): Array<string> {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type DiffOp = { readonly kind: " " | "-" | "+"; readonly line: string };

function diffMiddle(oldLines: ReadonlyArray<string>, newLines: ReadonlyArray<string>): DiffOp[] {
  const rows = oldLines.length;
  const columns = newLines.length;
  if (rows === 0 || columns === 0 || (rows + 1) * (columns + 1) > MAX_DIFF_CELLS) {
    return [
      ...oldLines.map((line): DiffOp => ({ kind: "-", line })),
      ...newLines.map((line): DiffOp => ({ kind: "+", line })),
    ];
  }

  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lengths[row * width + column] =
        oldLines[row] === newLines[column]
          ? (lengths[(row + 1) * width + column + 1] ?? 0) + 1
          : Math.max(
              lengths[(row + 1) * width + column] ?? 0,
              lengths[row * width + column + 1] ?? 0,
            );
    }
  }

  const ops: DiffOp[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (oldLines[row] === newLines[column]) {
      ops.push({ kind: " ", line: oldLines[row] ?? "" });
      row += 1;
      column += 1;
    } else if (
      (lengths[(row + 1) * width + column] ?? 0) >= (lengths[row * width + column + 1] ?? 0)
    ) {
      ops.push({ kind: "-", line: oldLines[row] ?? "" });
      row += 1;
    } else {
      ops.push({ kind: "+", line: newLines[column] ?? "" });
      column += 1;
    }
  }
  while (row < rows) ops.push({ kind: "-", line: oldLines[row++] ?? "" });
  while (column < columns) ops.push({ kind: "+", line: newLines[column++] ?? "" });
  return ops;
}

function formatHunkRange(start: number, count: number): string {
  if (count === 1) return `${start}`;
  return `${count === 0 ? start - 1 : start},${count}`;
}

/** Returns an empty string when the two texts have the same lines. */
export function buildUnifiedDiff(
  oldText: string,
  newText: string,
  options: UnifiedDiffOptions = {},
): string {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  const context = Math.max(0, options.contextLines ?? 3);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: DiffOp[] = [
    ...oldLines.slice(0, prefix).map((line): DiffOp => ({ kind: " ", line })),
    ...diffMiddle(
      oldLines.slice(prefix, oldLines.length - suffix),
      newLines.slice(prefix, newLines.length - suffix),
    ),
    ...oldLines.slice(oldLines.length - suffix).map((line): DiffOp => ({ kind: " ", line })),
  ];

  const changed = ops.flatMap((op, position) => (op.kind === " " ? [] : [position]));
  if (changed.length === 0) return "";

  const ranges: Array<{ from: number; to: number }> = [];
  for (const position of changed) {
    const from = Math.max(0, position - context);
    const to = Math.min(ops.length, position + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last.to) last.to = to;
    else ranges.push({ from, to });
  }

  const output = [`--- ${options.oldLabel ?? "old"}`, `+++ ${options.newLabel ?? "new"}`];
  let oldCursor = 1;
  let newCursor = 1;
  let consumed = 0;
  for (const { from, to } of ranges) {
    for (; consumed < from; consumed += 1) {
      if (ops[consumed]?.kind !== "+") oldCursor += 1;
      if (ops[consumed]?.kind !== "-") newCursor += 1;
    }
    const hunk = ops.slice(from, to);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    output.push(
      `@@ -${formatHunkRange(oldCursor, oldCount)} +${formatHunkRange(newCursor, newCount)} @@`,
    );
    for (const op of hunk) output.push(`${op.kind}${op.line}`);
    for (; consumed < to; consumed += 1) {
      if (ops[consumed]?.kind !== "+") oldCursor += 1;
      if (ops[consumed]?.kind !== "-") newCursor += 1;
    }
  }
  return output.join("\n");
}

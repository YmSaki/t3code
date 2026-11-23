import { describe, expect, it } from "vite-plus/test";

import {
  buildMarkdownRevisionPrompt,
  buildUnifiedDiff,
  extractLineSelection,
  listTaskCheckboxes,
  normalizeLineRange,
  toggleTaskCheckbox,
} from "./markdownArtifact.core.ts";

const checklist = [
  "# Plan",
  "- [ ] first",
  "- [x] second",
  "  * [X] nested",
  "1. [ ] numbered",
].join("\n");

describe("listTaskCheckboxes", () => {
  it("lists task items in document order with their state", () => {
    expect(listTaskCheckboxes(checklist)).toEqual([
      { index: 0, line: 2, checked: false, text: "first" },
      { index: 1, line: 3, checked: true, text: "second" },
      { index: 2, line: 4, checked: true, text: "nested" },
      { index: 3, line: 5, checked: false, text: "numbered" },
    ]);
  });

  it("ignores lookalikes and fenced code", () => {
    const markdown = [
      "- [ ] real",
      "- [] empty",
      "- [ ]glued",
      "- [y] other",
      "```md",
      "- [ ] in backtick fence",
      "```",
      "~~~~",
      "- [ ] in tilde fence",
      "~~~",
      "- [ ] still in tilde fence",
      "~~~~",
      "````",
      "```",
      "- [ ] inside longer fence",
      "````",
      "- [x] after",
    ].join("\n");
    expect(listTaskCheckboxes(markdown).map((item) => item.text)).toEqual(["real", "after"]);
  });

  it("treats an unclosed fence as running to the end", () => {
    expect(listTaskCheckboxes("- [ ] a\n```\n- [ ] b")).toHaveLength(1);
  });
});

describe("toggleTaskCheckbox", () => {
  it("toggles by occurrence index and leaves other text untouched", () => {
    const result = toggleTaskCheckbox(checklist, 0);
    expect(result).toEqual({
      ok: true,
      checked: true,
      markdown: checklist.replace("- [ ] first", "- [x] first"),
    });
    expect(toggleTaskCheckbox(checklist, 2)).toMatchObject({
      checked: false,
      markdown: checklist.replace("* [X] nested", "* [ ] nested"),
    });
  });

  it("sets an explicit state idempotently", () => {
    expect(toggleTaskCheckbox(checklist, 1, true)).toMatchObject({ ok: true, markdown: checklist });
  });

  it("skips fenced items when counting the index", () => {
    const markdown = "```\n- [ ] fake\n```\n- [ ] real";
    expect(toggleTaskCheckbox(markdown, 0)).toEqual({
      ok: true,
      checked: true,
      markdown: "```\n- [ ] fake\n```\n- [x] real",
    });
    expect(toggleTaskCheckbox(markdown, 1)).toEqual({ ok: false, reason: "index_out_of_range" });
  });

  it("preserves CRLF and bare CR line endings", () => {
    expect(toggleTaskCheckbox("a\r\n- [ ] b\r\n- [ ] c\r\n", 1)).toMatchObject({
      markdown: "a\r\n- [ ] b\r\n- [x] c\r\n",
    });
    expect(toggleTaskCheckbox("- [ ] a\r- [ ] b", 1)).toMatchObject({
      markdown: "- [ ] a\r- [x] b",
    });
  });

  it("rejects invalid indexes", () => {
    for (const index of [-1, 4, 1.5, Number.NaN]) {
      expect(toggleTaskCheckbox(checklist, index)).toEqual({
        ok: false,
        reason: "index_out_of_range",
      });
    }
  });
});

describe("line selections", () => {
  const markdown = "one\ntwo\nthree\nfour\n";

  it("normalizes reversed and overflowing ranges", () => {
    expect(normalizeLineRange(markdown, { startLine: 3, endLine: 2 })).toEqual({
      startLine: 2,
      endLine: 3,
    });
    expect(normalizeLineRange(markdown, { startLine: 0, endLine: 99 })).toEqual({
      startLine: 1,
      endLine: 4,
    });
    expect(normalizeLineRange(markdown, { startLine: 5, endLine: 9 })).toBeNull();
    expect(normalizeLineRange(markdown, { startLine: -3, endLine: 0 })).toBeNull();
    expect(normalizeLineRange(markdown, { startLine: 1.5, endLine: 2 })).toBeNull();
  });

  it("extracts the selected lines", () => {
    expect(extractLineSelection(markdown, { startLine: 2, endLine: 3 })).toEqual({
      startLine: 2,
      endLine: 3,
      text: "two\nthree",
    });
  });
});

describe("buildMarkdownRevisionPrompt", () => {
  const markdown = "# Title\n\nIntro text\n\n```ts\ncode\n```\n\nEnd";

  it("quotes each selection beside its request, in document order", () => {
    const prompt = buildMarkdownRevisionPrompt({
      title: "Spec",
      artifactId: "artifact-1",
      markdown,
      comments: [
        { startLine: 9, endLine: 9, comment: "Expand the ending" },
        { startLine: 3, endLine: 1, comment: "  Tighten the intro " },
      ],
    });
    expect(prompt).toContain('the markdown artifact "Spec" (id: artifact-1)');
    expect(prompt).toContain(
      "1. lines 1-3\n```markdown\n# Title\n\nIntro text\n```\nRequest: Tighten the intro",
    );
    expect(prompt).toContain("2. line 9\n```markdown\nEnd\n```\nRequest: Expand the ending");
  });

  it("uses a fence longer than any backtick run in the quote", () => {
    const prompt = buildMarkdownRevisionPrompt({
      title: "Spec",
      markdown,
      comments: [{ startLine: 5, endLine: 7, comment: "Rename" }],
    });
    expect(prompt).toContain("````markdown\n```ts\ncode\n```\n````");
  });

  it("returns null when no comment can be resolved", () => {
    expect(
      buildMarkdownRevisionPrompt({
        title: "Spec",
        markdown,
        comments: [
          { startLine: 50, endLine: 60, comment: "Out of range" },
          { startLine: 1, endLine: 1, comment: "   " },
        ],
      }),
    ).toBeNull();
  });
});

describe("buildUnifiedDiff", () => {
  it("returns an empty string for identical text", () => {
    expect(buildUnifiedDiff("a\nb\n", "a\nb\n")).toBe("");
    expect(buildUnifiedDiff("", "")).toBe("");
  });

  it("renders a replacement with context and labels", () => {
    expect(buildUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", { oldLabel: "v1", newLabel: "v2" })).toBe(
      ["--- v1", "+++ v2", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"].join("\n"),
    );
  });

  it("splits distant changes into separate hunks with correct offsets", () => {
    const oldLines = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
    const newLines = [...oldLines];
    newLines[1] = "changed2";
    newLines.splice(17, 1);
    const diff = buildUnifiedDiff(oldLines.join("\n"), newLines.join("\n"), { contextLines: 1 });
    expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -1,3 +1,3 @@",
      "@@ -17,3 +17,2 @@",
    ]);
    expect(diff).toContain("-line18");
  });

  it("merges hunks whose context touches", () => {
    const diff = buildUnifiedDiff("1\n2\n3\n4\n5\n", "1\nx\n3\ny\n5\n", { contextLines: 1 });
    expect(diff.match(/^@@/gm)).toHaveLength(1);
  });

  it("handles insertion into and deletion of everything", () => {
    expect(buildUnifiedDiff("", "a\nb")).toBe(
      ["--- old", "+++ new", "@@ -0,0 +1,2 @@", "+a", "+b"].join("\n"),
    );
    expect(buildUnifiedDiff("a", "")).toBe(
      ["--- old", "+++ new", "@@ -1 +0,0 @@", "-a"].join("\n"),
    );
  });

  it("treats CRLF and LF text as the same lines", () => {
    expect(buildUnifiedDiff("a\r\nb\r\n", "a\nb\n")).toBe("");
  });

  it("falls back to a full replacement for very large middles", () => {
    const oldText = Array.from({ length: 2100 }, (_, index) => `o${index}`).join("\n");
    const newText = Array.from({ length: 2100 }, (_, index) => `n${index}`).join("\n");
    const diff = buildUnifiedDiff(oldText, newText, { contextLines: 0 });
    expect(diff.split("\n").filter((line) => line.startsWith("-o"))).toHaveLength(2100);
    expect(diff.split("\n").filter((line) => line.startsWith("+n"))).toHaveLength(2100);
  });
});

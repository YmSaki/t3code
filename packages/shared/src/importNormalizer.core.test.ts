import { describe, expect, it } from "vite-plus/test";
import {
  buildImportDiagnosticSummary,
  importPathComparisonKey,
  isSameImportDirectory,
  normalizeImportMessages,
  normalizeImportRole,
  parseImportTimestampMs,
  toImportPathKey,
} from "./importNormalizer.core.ts";

describe("toImportPathKey", () => {
  it.each([
    ["C:\\Users\\Me\\Repo\\", { distro: null, path: "c:/users/me/repo" }],
    ["c:/users/me/repo", { distro: null, path: "c:/users/me/repo" }],
    ["/C:/Users/Me/Repo", { distro: null, path: "c:/users/me/repo" }],
    ["C:\\", { distro: null, path: "c:/" }],
    ["C:\\a\\.\\b\\..\\c", { distro: null, path: "c:/a/c" }],
    ["\\\\Server\\Share\\Dir\\", { distro: null, path: "//server/share/dir" }],
    ["\\\\wsl$\\Ubuntu\\home\\me\\repo", { distro: "ubuntu", path: "/home/me/repo" }],
    [
      "\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\repo\\",
      { distro: "ubuntu-22.04", path: "/home/me/repo" },
    ],
    ["\\\\wsl$\\Ubuntu", { distro: "ubuntu", path: "/" }],
    ["/home/me/Repo//", { distro: null, path: "/home/me/Repo" }],
    ["/", { distro: null, path: "/" }],
    ["/mnt/c/Users/Me", { distro: null, path: "c:/users/me" }],
    ["\\\\wsl$\\Ubuntu\\mnt\\d\\Work", { distro: "ubuntu", path: "d:/work" }],
    ["  ", { distro: null, path: "" }],
  ])("normalizes %j", (input, expected) => {
    expect(toImportPathKey(input)).toEqual(expected);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(importPathComparisonKey("/home/Me/Repo")).not.toBe(
      importPathComparisonKey("/home/me/repo"),
    );
  });
});

describe("isSameImportDirectory", () => {
  it.each([
    ["C:\\Repo\\App", "c:/repo/app/", true],
    ["\\\\wsl$\\Ubuntu\\home\\me\\app", "/home/me/app", true],
    ["\\\\wsl.localhost\\Ubuntu\\home\\me\\app\\", "\\\\wsl$\\ubuntu\\home\\me\\app", true],
    ["\\\\wsl$\\Ubuntu\\home\\me\\app", "\\\\wsl$\\Debian\\home\\me\\app", false],
    ["/mnt/c/Repo/App", "C:\\repo\\app", true],
    ["/home/me/app", "/home/me/app2", false],
    ["/home/me/App", "/home/me/app", false],
    ["", "", false],
  ])("compares %j with %j", (left, right, expected) => {
    expect(isSameImportDirectory(left, right)).toBe(expected);
  });
});

describe("parseImportTimestampMs", () => {
  it.each([
    ["2025-01-02T03:04:05.000Z", 1735787045000],
    [1735787045, 1735787045000],
    [1735787045123, 1735787045123],
    ["1735787045", 1735787045000],
    ["1735787045123", 1735787045123],
    ["", null],
    ["not a date", null],
    [0, null],
    [-5, null],
    [Number.NaN, null],
    [null, null],
    [{}, null],
  ])("parses %j", (input, expected) => {
    expect(parseImportTimestampMs(input)).toBe(expected);
  });
});

describe("normalizeImportRole", () => {
  it.each([
    ["User", "user"],
    [" human ", "user"],
    ["AI", "assistant"],
    ["model", "assistant"],
    ["system", "unsupported"],
    ["tool", "unsupported"],
    ["wizard", "unknown"],
    [1, "unknown"],
  ])("maps %j", (input, expected) => {
    expect(normalizeImportRole(input)).toBe(expected);
  });
});

describe("normalizeImportMessages", () => {
  const fallbackCreatedAt = "2025-01-01T00:00:00.000Z";

  it("absorbs role variants, sorts by time and removes duplicates", () => {
    const result = normalizeImportMessages(
      [
        { role: "AI", text: "second", createdAt: "2025-01-02T00:00:02.000Z" },
        { role: "human", text: "  first \r\n", createdAt: 1735776001 },
        { role: "ai", text: "second", createdAt: "2025-01-02T00:00:02.000Z" },
      ],
      { fallbackCreatedAt },
    );
    expect(result.messages).toEqual([
      { role: "user", text: "first", createdAt: "2025-01-02T00:00:01.000Z" },
      { role: "assistant", text: "second", createdAt: "2025-01-02T00:00:02.000Z" },
    ]);
    expect(result.skipped).toEqual([{ index: 2, reason: "duplicate" }]);
  });

  it("keeps input order for equal timestamps", () => {
    const result = normalizeImportMessages(
      [
        { role: "user", text: "b", createdAt: 1735776000 },
        { role: "assistant", text: "a", createdAt: 1735776000 },
      ],
      { fallbackCreatedAt },
    );
    expect(result.messages.map((message) => message.text)).toEqual(["b", "a"]);
  });

  it("repairs missing timestamps from the previous message, then the fallback", () => {
    const result = normalizeImportMessages(
      [
        { role: "user", text: "one" },
        { role: "assistant", text: "two", createdAt: "2025-01-02T00:00:00.000Z" },
        { role: "user", text: "three", createdAt: "garbage" },
      ],
      { fallbackCreatedAt },
    );
    expect(result.messages.map((message) => message.createdAt)).toEqual([
      fallbackCreatedAt,
      "2025-01-02T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z",
    ]);
    expect(result.summary.repairedTimestampCount).toBe(2);
  });

  it("summarizes skipped records by reason", () => {
    const result = normalizeImportMessages(
      [
        null,
        "text",
        { role: "user", text: "   " },
        { role: "user" },
        { role: "system", text: "rules" },
        { role: "robot", text: "beep" },
        { role: "user", text: "ok", createdAt: 1735776000 },
      ],
      { fallbackCreatedAt },
    );
    expect(result.summary).toEqual({
      totalRecords: 7,
      importedCount: 1,
      skippedCount: 6,
      repairedTimestampCount: 0,
      byReason: [
        { reason: "empty_text", count: 2 },
        { reason: "not_an_object", count: 2 },
        { reason: "unknown_role", count: 1 },
        { reason: "unsupported_role", count: 1 },
      ],
    });
  });

  it("handles an empty input", () => {
    const result = normalizeImportMessages([], { fallbackCreatedAt });
    expect(result.messages).toEqual([]);
    expect(result.summary.byReason).toEqual([]);
  });
});

describe("buildImportDiagnosticSummary", () => {
  it("orders reasons by count then name", () => {
    const summary = buildImportDiagnosticSummary({
      totalRecords: 6,
      importedCount: 1,
      skippedReasons: ["b", "a", "b", "c", "a"],
    });
    expect(summary.byReason).toEqual([
      { reason: "a", count: 2 },
      { reason: "b", count: 2 },
      { reason: "c", count: 1 },
    ]);
    expect(summary.skippedCount).toBe(5);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  escapeIcalText,
  foldIcalLine,
  generateWorklogIcalFeed,
  ICAL_MAX_LINE_OCTETS,
  utf8ByteLength,
} from "./icalGenerator.core.ts";

describe("icalGenerator.core", () => {
  it("escapes backslashes, semicolons, commas, and newlines per RFC 5545", () => {
    const raw = "Fix bug; check A, B\\C\r\nand next line\nend";
    expect(escapeIcalText(raw)).toBe("Fix bug\\; check A\\, B\\\\C\\nand next line\\nend");
  });

  it("folds long lines at <= 75 UTF-8 octets without splitting multi-byte Japanese characters or emojis", () => {
    const japaneseLine =
      "SUMMARY:[cx] エージェント稼働カレンダーのiCal配信と日本語マルチバイト文字の安全な75バイト折返し検証テスト🚀完了";
    const folded = foldIcalLine(japaneseLine, ICAL_MAX_LINE_OCTETS);
    const physicalLines = folded.split("\r\n");

    expect(physicalLines.length).toBeGreaterThan(1);
    for (let i = 0; i < physicalLines.length; i++) {
      const line = physicalLines[i]!;
      expect(utf8ByteLength(line)).toBeLessThanOrEqual(ICAL_MAX_LINE_OCTETS);
      if (i > 0) {
        expect(line.startsWith(" ")).toBe(true);
      }
    }

    // Unfolding (removing CRLF + single space) must restore the exact original Unicode string
    const unfolded = folded.replace(/\r\n /g, "");
    expect(unfolded).toBe(japaneseLine);
  });

  it("generates a valid RFC 5545 VCALENDAR with VEVENT summary, categories, description, and CRLF endings", () => {
    const ics = generateWorklogIcalFeed(
      [
        {
          id: "wl-101",
          provider: "codex",
          title: "Implement iCal generator; verify UTF-8 folding, escaping",
          startedAt: "2026-11-22T09:00:00.000Z",
          endedAt: "2026-11-22T09:45:00.000Z",
          durationMs: 2_700_000,
          turnCount: 4,
          status: "completed",
          source: "t3_run",
          threadRole: "worker",
          projectTitle: "T3 Code",
          summary: "Implemented RFC 5545 generator with 75-octet folding.",
          stats: {
            changedFilesCount: 3,
            commandsCount: 7,
            inputTokens: 12000,
            outputTokens: 2500,
            cachedTokens: 6000,
            estimatedCostUsd: 0.185,
          },
          threadUrl: "https://app.t3.codes/threads/thread-101",
        },
      ],
      {
        calendarName: "T3 Worklog",
        timeZone: "Asia/Tokyo",
        generatedAt: "2026-11-22T10:00:00.000Z",
      },
    );

    expect(ics.endsWith("\r\n")).toBe(true);
    const physicalLines = ics.slice(0, -2).split("\r\n");
    for (const line of physicalLines) {
      expect(utf8ByteLength(line)).toBeLessThanOrEqual(ICAL_MAX_LINE_OCTETS);
    }

    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("BEGIN:VCALENDAR\r\n");
    expect(unfolded).toContain("BEGIN:VEVENT\r\n");
    expect(unfolded).toContain("DTSTART:20261122T090000Z\r\n");
    expect(unfolded).toContain("DTEND:20261122T094500Z\r\n");
    expect(unfolded).toContain(
      "SUMMARY:[cx] Implement iCal generator\\; verify UTF-8 folding\\, escaping\r\n",
    );
    expect(unfolded).toContain("CATEGORIES:codex,cx,worker,t3_run,T3 Code\r\n");
    expect(unfolded).toContain("Duration: 45m 00s\\nTurns: 4\\nChanged Files: 3 (Commands: 7)");
    expect(unfolded).toContain("Tokens: in 12000 / out 2500 / cached 6000\\nCost: $0.1850");
    expect(unfolded).toContain("Summary: Implemented RFC 5545 generator with 75-octet folding.");
    expect(unfolded).toContain("Thread URL: https://app.t3.codes/threads/thread-101");
    expect(unfolded).toContain("URL:https://app.t3.codes/threads/thread-101\r\n");
    expect(unfolded).toContain("END:VEVENT\r\nEND:VCALENDAR\r\n");
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  doWorklogIntervalsCollide,
  formatAgentSummaryTitle,
  getAgentShortCode,
  layoutWorklogDaySlices,
} from "./worklogLayout.core.ts";

describe("worklogLayout.core", () => {
  it("maps agent providers to 2-character short codes", () => {
    expect(getAgentShortCode("codex")).toBe("cx");
    expect(getAgentShortCode("claudeAgent")).toBe("cl");
    expect(getAgentShortCode("cursor")).toBe("cu");
    expect(getAgentShortCode("opencode")).toBe("oc");
    expect(getAgentShortCode("antigravity")).toBe("ag");
    expect(getAgentShortCode("pi")).toBe("pi");
    expect(getAgentShortCode("grok")).toBe("gr");
    expect(getAgentShortCode("kiro")).toBe("ki");
    expect(getAgentShortCode("fx")).toBe("fx");
    expect(getAgentShortCode("z")).toBe("zx");
    expect(getAgentShortCode("  ")).toBe("uk");

    expect(formatAgentSummaryTitle("codex", "Fix auth flow")).toBe("[cx] Fix auth flow");
  });

  it("detects interval collisions and allows touching boundaries without collision", () => {
    expect(doWorklogIntervalsCollide({ start: 10, end: 20 }, { start: 20, end: 30 })).toBe(false);
    expect(doWorklogIntervalsCollide({ start: 10, end: 20 }, { start: 15, end: 25 })).toBe(true);
    expect(doWorklogIntervalsCollide({ start: 10, end: 10 }, { start: 10, end: 10 })).toBe(true);
  });

  it("assigns greedy columns and reuses freed columns within an overlap cluster", () => {
    // 06:00 - 12:00 (360..720) -> col 0
    // 07:00 - 09:00 (420..540) -> col 1
    // 09:00 - 11:00 (540..660) -> col 1 (reuses col 1 since 07:00-09:00 ended at 540!)
    // 14:00 - 16:00 (840..960) -> separate cluster, col 0 of 1
    const items = layoutWorklogDaySlices([
      {
        id: "s1",
        provider: "codex",
        title: "Long morning session",
        startMinuteOfDay: 360,
        endMinuteOfDay: 720,
      },
      {
        id: "s2",
        provider: "claudeAgent",
        title: "Parallel sub-task 1",
        startMinuteOfDay: 420,
        endMinuteOfDay: 540,
      },
      {
        id: "s3",
        provider: "cursor",
        title: "Parallel sub-task 2",
        startMinuteOfDay: 540,
        endMinuteOfDay: 660,
      },
      {
        id: "s4",
        provider: "antigravity",
        title: "Afternoon standalone task",
        startMinuteOfDay: 840,
        endMinuteOfDay: 960,
      },
    ]);

    expect(items).toHaveLength(4);
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get("s1")?.columnIndex).toBe(0);
    expect(byId.get("s1")?.columnCount).toBe(2);
    expect(byId.get("s1")?.topPercent).toBe(25);
    expect(byId.get("s1")?.heightPercent).toBe(25);
    expect(byId.get("s1")?.labelDensity).toBe("detailed");

    expect(byId.get("s2")?.columnIndex).toBe(1);
    expect(byId.get("s2")?.columnCount).toBe(2);

    expect(byId.get("s3")?.columnIndex).toBe(1);
    expect(byId.get("s3")?.columnCount).toBe(2);

    expect(byId.get("s4")?.columnIndex).toBe(0);
    expect(byId.get("s4")?.columnCount).toBe(1);
    expect(byId.get("s4")?.displayLabel).toBe("[ag] Afternoon standalone task");
  });

  it("enforces minimum height and switches to compact or badge_only labels under high density", () => {
    const highDensitySlices = Array.from({ length: 6 }, (_, index) => ({
      id: `hd-${index}`,
      provider: index % 2 === 0 ? "codex" : "opencode",
      title: `Task ${index}`,
      startMinuteOfDay: 600,
      endMinuteOfDay: 602, // 2 minutes -> raw ~0.1389%, should clamp to minHeightPercent
    }));

    const items = layoutWorklogDaySlices(highDensitySlices, { minHeightPercent: 2.0 });
    expect(items).toHaveLength(6);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      expect(item.columnIndex).toBe(i);
      expect(item.columnCount).toBe(6);
      expect(item.heightPercent).toBe(2.0);
      expect(item.labelDensity).toBe("badge_only");
      expect(item.displayLabel).toBe(i % 2 === 0 ? "[cx]" : "[oc]");
    }
  });
});

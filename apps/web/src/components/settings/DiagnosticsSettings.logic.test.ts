import { describe, expect, it } from "vite-plus/test";

import { m } from "../../i18n/messages";
import {
  formatDiagnosticsDuration,
  formatProcessName,
  formatProcessType,
} from "./DiagnosticsSettings.logic";

describe("formatDiagnosticsDuration", () => {
  it("prints durations that round up to a second in seconds", () => {
    expect([999.4, 999.6, 1_000].map(formatDiagnosticsDuration)).toEqual(["999 ms", "1 s", "1 s"]);
  });
});

describe("diagnostics process labels", () => {
  it("keeps spaces in executable basenames", () => {
    expect(
      ["T3 Code.exe", "T3 Code.exe [claude]", "T3 Code [beta].exe"].map(formatProcessName),
    ).toEqual(["T3 Code.exe", "T3 Code.exe", "T3 Code [beta].exe"]);
  });

  it("recognizes all fixed provider labels and gives subprocess depth priority", () => {
    const providers = ["codex", "claude", "cursor", "opencode", "grok", "antigravity"];
    expect(
      providers.map((provider) =>
        formatProcessType({ command: `node.exe [${provider}]`, depth: 0 }, m),
      ),
    ).toEqual(providers.map(() => "Agent"));
    expect(formatProcessType({ command: "node.exe [grok]", depth: 1 }, m)).toBe("Subprocess");
    expect(formatProcessType({ command: "Claude Tools.exe", depth: 0 }, m)).toBe("Process");
    expect(formatProcessType({ command: "node.exe [claude] tool.js", depth: 0 }, m)).toBe(
      "Process",
    );
  });
});

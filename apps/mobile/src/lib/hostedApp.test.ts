import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { mobilePromptShareUrl, mobileThreadShareUrl } from "./hostedApp";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { scheme: "t3codejp", extra: { hostedAppUrl: "" } } },
}));

it("shares links through the fork app when it has no hosted Web origin", () => {
  expect(mobilePromptShareUrl("Read this & report")).toBe(
    "t3codejp://new?prompt=Read+this+%26+report",
  );
  expect(
    mobileThreadShareUrl({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("mcp:1"),
    }),
  ).toBe("t3codejp://threads/env/mcp%3A1");
});

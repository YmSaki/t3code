import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it("accepts the configured HTTPS origins and matches each one exactly", () => {
    const origins = ["https://fork.example.test", "https://nightly.fork.example.test"];
    expect(
      providerAuthReturnUrl(
        "https://nightly.fork.example.test/settings/providers?instanceId=work&code=secret",
        origins,
      ),
    ).toBe("https://nightly.fork.example.test/settings/providers?instanceId=work");
    for (const url of [
      "http://fork.example.test/welcome",
      "https://fork.example.test:8443/welcome",
      "https://fork.example.test.other.example/welcome",
      "https://fork.example.test@other.example/welcome",
      "https://fork.example.test/other",
      "https://app.t3.codes/welcome",
    ]) {
      expect(providerAuthReturnUrl(url, origins)).toBeUndefined();
    }
  });

  it.each(["t3codejp", "t3codejp-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "t3codejp://attacker/welcome",
    "t3codejp://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});

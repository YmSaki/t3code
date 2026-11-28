import { assert, it } from "@effect/vitest";
import {
  MACOS_MANAGED_PREFERENCES_PATH,
  WINDOWS_POLICY_GROUPS,
  WINDOWS_POLICY_KEY,
  WINDOWS_POLICY_LISTS,
  WINDOWS_POLICY_VALUES,
} from "@t3tools/shared/managedPolicyFile";

import { macosProfile, windowsAdmx } from "./policyTemplates.ts";

it("targets the preference domain the macOS reader loads", () => {
  const profile = macosProfile(
    { schemaVersion: 1, organization: "Example Corp" },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  if (profile._tag !== "Valid") return assert.fail(profile.reason);
  const payloadType = /<key>PayloadType<\/key>\s*<string>([^<]*)<\/string>/.exec(profile.profile);
  assert.strictEqual(
    `/Library/Managed Preferences/${payloadType?.[1]}.plist`,
    MACOS_MANAGED_PREFERENCES_PATH,
  );
});

it("gives every registry value the Windows reader accepts a Group Policy control", () => {
  const admx = windowsAdmx();
  for (const name of Object.keys(WINDOWS_POLICY_VALUES)) {
    assert.include(admx, `valueName="${name}"`);
  }
  for (const key of Object.keys(WINDOWS_POLICY_LISTS)) {
    assert.include(admx, `key="${WINDOWS_POLICY_KEY.slice("HKLM\\".length)}\\${key}"`);
  }
  for (const name of Object.keys(WINDOWS_POLICY_GROUPS)) {
    assert.include(admx, `valueName="${name}"`);
  }
});

it("refuses a profile for a policy with a null value, which a plist cannot hold", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: { defaultModelSelection: { value: null, locked: true } },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.deepStrictEqual(profile, {
    _tag: "Invalid",
    reason:
      "settings.defaultModelSelection is null, which a configuration profile cannot hold; deploy this policy as a file.",
  });
});

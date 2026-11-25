// @effect-diagnostics nodeBuiltinImport:off -- tests control DNS answers and local interfaces.
import type * as NodeDns from "node:dns";
import type * as NodeDnsPromises from "node:dns/promises";

import { expect, it, vi } from "vite-plus/test";

import { isLocalIpLiteral, resolvePublicLookup } from "./publicAddresses.ts";

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<NodeDns.LookupAddress[]>>(),
}));

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeDnsPromises>()),
  lookup,
}));

vi.mock("node:os", () => ({
  networkInterfaces: () => ({ test: [{ address: "198.51.100.7", family: "IPv4" }] }),
}));

it("rejects mapped local IPv4 literals and DNS answers in dotted and hexadecimal forms", async () => {
  lookup.mockReset();
  for (const address of [
    "::ffff:0.0.0.0",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "0:0:0:0:0:ffff:0a00:0001",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:100.64.0.1",
    "::ffff:169.254.169.254",
    "::ffff:172.16.0.1",
    "::ffff:192.168.0.1",
    "::ffff:198.18.0.1",
    "::ffff:224.0.0.1",
    "::ffff:198.51.100.7",
    "::ffff:c633:6407",
  ]) {
    expect(isLocalIpLiteral(address), address).toBe(true);
    expect(isLocalIpLiteral(new URL(`https://[${address}]/sub`).hostname.slice(1, -1))).toBe(true);
    expect(await resolvePublicLookup(address), address).toBeUndefined();
    lookup.mockResolvedValueOnce([{ address, family: 6 }]);
    expect(await resolvePublicLookup("push.example.com"), address).toBeUndefined();
  }
});

it("rejects mixed DNS answers containing a mapped private address in either order", async () => {
  lookup.mockReset();
  const answers = [
    { address: "93.184.215.14", family: 4 },
    { address: "::ffff:a00:1", family: 6 },
  ];
  for (const addresses of [answers, answers.toReversed()]) {
    lookup.mockResolvedValueOnce(addresses);
    const blocked = vi.fn();
    expect(await resolvePublicLookup("push.example.com", blocked)).toBeUndefined();
    expect(blocked).toHaveBeenCalledExactlyOnceWith(addresses);
  }
});

it("allows mapped public IPv4 and pins both lookup modes to the checked address", async () => {
  lookup.mockReset();
  for (const address of ["::ffff:93.184.215.14", "::ffff:5db8:d70e"]) {
    expect(isLocalIpLiteral(address), address).toBe(false);
    const answers = [{ address, family: 6 }];
    lookup.mockResolvedValueOnce(answers);
    const pinned = await resolvePublicLookup("push.example.com");
    expect(pinned).toBeDefined();
    const callback = vi.fn();
    pinned!("push.example.com", { all: true }, callback);
    pinned!("push.example.com", {}, callback);
    expect(callback.mock.calls).toEqual([
      [null, answers],
      [null, address, 6],
    ]);
  }
});

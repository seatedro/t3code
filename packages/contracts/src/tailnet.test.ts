import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { TailnetPeer } from "./tailnet.ts";

const decode = Schema.decodeUnknownExit(TailnetPeer);
const peer = (
  httpBaseUrl: string,
  own: { readonly tailnetAddress?: string; readonly magicDnsName?: string } = {},
) => ({
  name: "studio",
  magicDnsName: own.magicDnsName ?? "studio.tail1234.ts.net",
  tailnetAddress: own.tailnetAddress ?? "100.64.0.4",
  os: "macOS",
  online: true,
  environmentId: "env-studio",
  label: "Studio",
  httpBaseUrl,
});

describe("TailnetPeer", () => {
  it.each([
    ["http://100.64.0.4:3773/", true],
    ["https://studio.tail1234.ts.net/", true],
    ["http://STUDIO.tail1234.ts.net:3773/", true],
    // A peer list must not send a client elsewhere under a machine's name.
    ["http://evil.example:3773/", false],
    ["http://100.64.0.5:3773/", false],
    ["https://studio.tail1234.ts.net.evil.example/", false],
    ["ftp://100.64.0.4/", false],
    ["not a url", false],
  ])("accepts %s: %s", (httpBaseUrl, accepted) => {
    expect(Exit.isSuccess(decode(peer(httpBaseUrl)))).toBe(accepted);
  });

  it("refuses a peer whose own address is off the tailnet, even when the URL matches it", () => {
    for (const [httpBaseUrl, own] of [
      ["http://203.0.113.4:3773/", { tailnetAddress: "203.0.113.4" }],
      ["http://192.168.1.4:3773/", { tailnetAddress: "192.168.1.4" }],
      ["https://studio.evil.example/", { magicDnsName: "studio.evil.example" }],
    ] as const) {
      expect(Exit.isSuccess(decode(peer(httpBaseUrl, own)))).toBe(false);
    }
    expect(
      Exit.isSuccess(
        decode(peer("http://[fd7a:115c:a1e0::4]:3773/", { tailnetAddress: "fd7a:115c:a1e0::4" })),
      ),
    ).toBe(true);
  });
});

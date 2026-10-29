import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { TailnetPeer } from "./tailnet.ts";

const decode = Schema.decodeUnknownExit(TailnetPeer);
const peer = (httpBaseUrl: string) => ({
  name: "studio",
  magicDnsName: "studio.tail1234.ts.net",
  tailnetAddress: "100.64.0.4",
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
});

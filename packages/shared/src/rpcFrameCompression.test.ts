import { describe, expect, it } from "vite-plus/test";

import { inflatingJson, withFrameCompressionRequest } from "./rpcFrameCompression.ts";
import { deflatingJson, requestsFrameCompression } from "./rpcFrameDeflate.ts";

const SOCKET_URL = "wss://host.example/ws?orchestrationProtocol=2&wsTicket=t";

// Words that do not repeat, so only the window across frames can shrink a repeat.
const WORDS = Array.from({ length: 30_000 }, (_, index) =>
  ((index * 7_919) % 100_003).toString(36),
);

function streamedReply(length: number) {
  const text = `ünïcödé 🐑 ${WORDS.join(" ")}`.slice(0, length);
  return {
    _tag: "Chunk",
    requestId: "7",
    values: [{ kind: "event", event: { type: "message.updated", payload: { id: "m", text } } }],
  };
}

describe("rpc frame compression", () => {
  it.each([
    { name: "asked, no extension offered", query: true, header: undefined, expected: true },
    { name: "not asked", query: false, header: undefined, expected: false },
    {
      name: "asked, permessage-deflate offered",
      query: true,
      header: "permessage-deflate; client_max_window_bits",
      expected: false,
    },
    {
      name: "asked, offered among other extensions",
      query: true,
      header: ["x-webkit-deflate-frame", "Permessage-Deflate"],
      expected: false,
    },
    { name: "asked, another extension only", query: true, header: "x-custom", expected: true },
  ])("compresses only when asked without a permessage-deflate offer: $name", (row) => {
    const url = new URL(row.query ? withFrameCompressionRequest(SOCKET_URL) : SOCKET_URL);
    expect(requestsFrameCompression(url, row.header)).toBe(row.expected);
  });

  it("decodes every frame on arrival, across sizes, from one shared window", () => {
    const server = deflatingJson.makeUnsafe();
    const client = inflatingJson.makeUnsafe();
    // Growing replies, a frame past pako's 16 KiB output chunk, incompressible text that deflate
    // stores rather than codes, and tiny control frames.
    let seed = 7;
    const noise = Array.from({ length: 70_000 }, () =>
      String.fromCharCode(33 + ((seed = (seed * 48_271) % 2_147_483_647) % 94)),
    ).join("");
    const messages = [
      { _tag: "Pong" },
      ...[40, 400, 4_000, 40_000, 120_000].map(streamedReply),
      { _tag: "Chunk", requestId: "8", values: [noise] },
      { _tag: "Exit", requestId: "7", exit: { _tag: "Success", value: null } },
    ];
    for (const message of messages) {
      const frame = server.encode(message);
      expect(frame).toBeInstanceOf(Uint8Array);
      expect(client.decode(frame as Uint8Array)).toEqual([message]);
    }
  });

  it("sends a repeated body as a back-reference, not again", () => {
    const server = deflatingJson.makeUnsafe();
    const first = server.encode(streamedReply(8_000)) as Uint8Array;
    const repeat = server.encode(streamedReply(8_000)) as Uint8Array;
    expect(repeat.length).toBeLessThan(first.length / 10);
  });

  it("parses text frames from servers that send plain JSON", () => {
    const client = inflatingJson.makeUnsafe();
    expect(client.decode(JSON.stringify({ _tag: "Pong" }))).toEqual([{ _tag: "Pong" }]);
    expect(deflatingJson.makeUnsafe().decode(JSON.stringify({ _tag: "Ping" }))).toEqual([
      { _tag: "Ping" },
    ]);
  });
});

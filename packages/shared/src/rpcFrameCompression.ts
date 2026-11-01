import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Inflate } from "fflate";

// React Native's iOS socket offers no permessage-deflate. When a client asks on the socket URL
// and its upgrade offered no permessage-deflate, the server sends each message as one binary
// frame from a per-socket raw deflate stream (`rpcFrameDeflate.ts`), sync-flushed per message.
// Client frames stay JSON text and text frames parse as before, so either side may be older.
export const FRAME_COMPRESSION_QUERY_PARAM = "frameCompression";
export const FRAME_COMPRESSION_DEFLATE = "deflate";

export function withFrameCompressionRequest(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(FRAME_COMPRESSION_QUERY_PARAM, FRAME_COMPRESSION_DEFLATE);
  return url.toString();
}

export function joinFrameChunks(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export function decodeJsonFrame(text: string): ReadonlyArray<unknown> {
  const decoded: unknown = JSON.parse(text);
  return Array.isArray(decoded) ? decoded : [decoded];
}

const textDecoder = new TextDecoder();

/** Client side: sends JSON text, inflates binary frames, and parses text frames as plain JSON. */
export const inflatingJson = RpcSerialization.RpcSerialization.of({
  ...RpcSerialization.json,
  makeUnsafe: () => {
    let output: Array<Uint8Array> = [];
    const inflate = new Inflate((chunk) => {
      output.push(chunk);
    });
    return {
      decode: (data) => {
        if (typeof data === "string") return decodeJsonFrame(data);
        inflate.push(data);
        if (output.length === 0) return [];
        const text = textDecoder.decode(joinFrameChunks(output));
        output = [];
        return decodeJsonFrame(text);
      },
      encode: (message) => JSON.stringify(message),
    };
  },
});

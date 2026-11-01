import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { Deflate, Z_SYNC_FLUSH } from "pako";

import {
  decodeJsonFrame,
  FRAME_COMPRESSION_DEFLATE,
  FRAME_COMPRESSION_QUERY_PARAM,
  joinFrameChunks,
} from "./rpcFrameCompression.ts";

// pako, not fflate: fflate's sync-flushed deflate output does not decode frame by frame.
// Clients inflate with fflate, which keeps pako out of their bundles.

export function requestsFrameCompression(
  url: URL,
  extensionsHeader: string | ReadonlyArray<string> | undefined,
): boolean {
  if (url.searchParams.get(FRAME_COMPRESSION_QUERY_PARAM) !== FRAME_COMPRESSION_DEFLATE) {
    return false;
  }
  const offered = typeof extensionsHeader === "string" ? [extensionsHeader] : extensionsHeader;
  return !offered?.some((value) => /(?:^|,)\s*permessage-deflate\b/i.test(value));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Server side: parses JSON text from the client and deflates everything it sends. */
export const deflatingJson = RpcSerialization.RpcSerialization.of({
  ...RpcSerialization.json,
  makeUnsafe: () => {
    const deflate = new Deflate({ raw: true });
    let output: Array<Uint8Array> = [];
    deflate.onData = (chunk) => {
      output.push(chunk);
    };
    return {
      decode: (data) => decodeJsonFrame(typeof data === "string" ? data : textDecoder.decode(data)),
      encode: (message) => {
        deflate.push(textEncoder.encode(JSON.stringify(message)), Z_SYNC_FLUSH);
        if (deflate.err !== 0) throw new Error(`Frame deflate failed: ${deflate.msg}`);
        const frame = joinFrameChunks(output);
        output = [];
        return frame;
      },
    };
  },
});

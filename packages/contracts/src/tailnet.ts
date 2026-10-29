import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "")
      : null;
  } catch {
    return null;
  }
};

/**
 * A machine on the environment's tailnet that answered as a T3 Code server. Its address must
 * be the machine's own, so a peer list cannot send a client somewhere else under its name.
 */
export const TailnetPeer = Schema.Struct({
  /** Tailscale's machine name, the first label of its MagicDNS name. */
  name: TrimmedNonEmptyString,
  magicDnsName: Schema.NullOr(TrimmedNonEmptyString),
  tailnetAddress: TrimmedNonEmptyString,
  os: Schema.NullOr(TrimmedNonEmptyString),
  online: Schema.Boolean,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** The address that answered, which a client on the tailnet can connect to. */
  httpBaseUrl: TrimmedNonEmptyString,
}).check(
  Schema.makeFilter((peer) => {
    const host = hostOf(peer.httpBaseUrl);
    return (
      host !== null &&
      (host === peer.tailnetAddress.toLowerCase() || host === peer.magicDnsName?.toLowerCase())
    );
  }),
);
export type TailnetPeer = typeof TailnetPeer.Type;

export const TailnetPeersResult = Schema.Struct({
  /** False when this machine's Tailscale is not running or not signed in. */
  available: Schema.Boolean,
  peers: Schema.Array(TailnetPeer),
});
export type TailnetPeersResult = typeof TailnetPeersResult.Type;

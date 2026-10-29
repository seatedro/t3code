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

/** A Tailscale address or MagicDNS name: 100.64.0.0/10, fd7a:115c:a1e0::/48, or `*.ts.net`. */
const isTailnetHost = (host: string): boolean => {
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet))) {
    const [first, second] = octets.map(Number);
    return first === 100 && second !== undefined && second >= 64 && second <= 127;
  }
  return host.startsWith("fd7a:115c:a1e0:") || (host.endsWith(".ts.net") && host !== ".ts.net");
};

/**
 * A machine on the environment's tailnet that answered as a T3 Code server. Its address must
 * be on the tailnet and the machine's own, so a peer list cannot send a client elsewhere.
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
      isTailnetHost(host) &&
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

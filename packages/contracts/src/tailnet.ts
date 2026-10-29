import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A machine on the environment's tailnet that answered as a T3 Code server. */
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
});
export type TailnetPeer = typeof TailnetPeer.Type;

export const TailnetPeersResult = Schema.Struct({
  /** False when this machine's Tailscale is not running or not signed in. */
  available: Schema.Boolean,
  peers: Schema.Array(TailnetPeer),
});
export type TailnetPeersResult = typeof TailnetPeersResult.Type;

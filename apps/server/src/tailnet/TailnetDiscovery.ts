import {
  ExecutionEnvironmentDescriptor,
  type TailnetPeer,
  type TailnetPeersResult,
} from "@t3tools/contracts";
import { buildTailscaleHttpsBaseUrl, type TailscaleNode } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { TailscaleLocal } from "./TailscaleLocal.ts";

const DEFAULT_T3_PORT = 3773;
const PROBE_TIMEOUT = Duration.millis(1_500);
const PROBE_CONCURRENCY = 16;
const RESULT_TTL = Duration.seconds(30);
// Phones and tablets cannot host a T3 server, so probing them only costs time.
const NON_HOST_OS = new Set(["ios", "android"]);

/** Machines on this environment's tailnet that answer as T3 servers. */
export class TailnetDiscovery extends Context.Service<
  TailnetDiscovery,
  {
    readonly peers: Effect.Effect<TailnetPeersResult>;
  }
>()("t3/tailnet/TailnetDiscovery") {}

const isCandidate = (node: TailscaleNode) =>
  node.online &&
  !node.sharee &&
  !NON_HOST_OS.has(node.os?.toLowerCase() ?? "") &&
  node.tailnetIpv4Addresses.length > 0;

/** Preferred first: Tailscale Serve's HTTPS name, then the direct ports. */
const candidateBaseUrls = (node: TailscaleNode, ports: ReadonlySet<number>): string[] => {
  const address = node.tailnetIpv4Addresses[0];
  return [
    ...(node.magicDnsName === null
      ? []
      : [buildTailscaleHttpsBaseUrl({ magicDnsName: node.magicDnsName })]),
    ...(address === undefined ? [] : [...ports].map((port) => `http://${address}:${port}/`)),
  ];
};

/** @public */
export const make = Effect.gen(function* () {
  const tailscale = yield* TailscaleLocal;
  const httpClient = yield* HttpClient.HttpClient;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const ports = new Set([DEFAULT_T3_PORT, config.port]);

  const probe = (baseUrl: string) =>
    httpClient
      .execute(HttpClientRequest.get(new URL("/.well-known/t3/environment", baseUrl).toString()))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
        Effect.timeoutOption(PROBE_TIMEOUT),
        Effect.orElseSucceed(() => Option.none<ExecutionEnvironmentDescriptor>()),
      );

  const discover = Effect.gen(function* () {
    const tailnet = yield* tailscale.tailnet;
    if (tailnet === null) return { available: false, peers: [] };
    const ownEnvironmentId = yield* environment.getEnvironmentId;

    const probes = tailnet.peers
      .filter(isCandidate)
      .flatMap((node) => candidateBaseUrls(node, ports).map((baseUrl) => ({ node, baseUrl })));
    const answers = yield* Effect.forEach(
      probes,
      ({ node, baseUrl }) =>
        probe(baseUrl).pipe(Effect.map((descriptor) => ({ node, baseUrl, descriptor }))),
      { concurrency: PROBE_CONCURRENCY },
    );

    const peers = new Map<TailscaleNode, TailnetPeer>();
    for (const { node, baseUrl, descriptor } of answers) {
      if (peers.has(node) || Option.isNone(descriptor)) continue;
      if (descriptor.value.environmentId === ownEnvironmentId) continue;
      const tailnetAddress = node.tailnetIpv4Addresses[0] ?? "";
      peers.set(node, {
        name: node.name ?? tailnetAddress,
        magicDnsName: node.magicDnsName,
        tailnetAddress,
        os: node.os,
        online: node.online,
        environmentId: descriptor.value.environmentId,
        label: descriptor.value.label,
        httpBaseUrl: baseUrl,
      });
    }
    return {
      available: true,
      peers: [...peers.values()].toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  });

  const cached = yield* Effect.cachedWithTTL(discover, (exit) =>
    Exit.isSuccess(exit) ? RESULT_TTL : Duration.zero,
  );

  return TailnetDiscovery.of({
    peers: cached.pipe(Effect.withSpan("TailnetDiscovery.peers")),
  });
});

export const layer = Layer.effect(TailnetDiscovery, make);

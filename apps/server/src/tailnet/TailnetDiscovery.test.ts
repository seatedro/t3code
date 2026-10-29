import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import type { TailscaleNode, TailscaleTailnet } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as TailnetDiscovery from "./TailnetDiscovery.ts";
import { TailscaleLocal } from "./TailscaleLocal.ts";

const OWN_ENVIRONMENT_ID = EnvironmentId.make("own-environment");
const SERVER_PORT = 13773;

const node = (
  name: string,
  address: string,
  overrides: Partial<TailscaleNode> = {},
): TailscaleNode => ({
  stableId: `n${name}`,
  name,
  magicDnsName: `${name}.tail.ts.net`,
  os: "linux",
  userId: 1,
  loginName: "owner@github",
  tagged: false,
  tailnetIpv4Addresses: [address],
  online: true,
  sharee: false,
  ...overrides,
});

const descriptor = (environmentId: string, label: string): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
});

const makeHarness = (
  tailnet: TailscaleTailnet | null,
  answers: Readonly<Record<string, ExecutionEnvironmentDescriptor>>,
) => {
  const probed: string[] = [];
  const layer = TailnetDiscovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          TailscaleLocal,
          TailscaleLocal.of({
            tailnet: Effect.succeed(tailnet),
            whois: () => Effect.succeed(null),
          }),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            probed.push(request.url);
            const answer = answers[request.url];
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                answer === undefined ? new Response(null, { status: 404 }) : Response.json(answer),
              ),
            );
          }),
        ),
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, port: SERVER_PORT })),
        ).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-discovery-" })),
          Layer.provide(NodeServices.layer),
        ),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(OWN_ENVIRONMENT_ID),
        }),
      ),
    ),
  );
  return { probed, layer };
};

const peers = Effect.flatMap(TailnetDiscovery.TailnetDiscovery, (discovery) => discovery.peers);

it.effect("lists tailnet peers that answer as T3 servers", () => {
  const { probed, layer } = makeHarness(
    {
      running: true,
      self: node("pulsar", "100.64.0.1"),
      peers: [
        node("beta", "100.64.0.4"),
        node("alpha", "100.64.0.5"),
        node("offline", "100.64.0.7", { online: false }),
        node("friend", "100.64.0.8", { sharee: true }),
        node("phone", "100.64.0.9", { os: "iOS" }),
        node("noaddress", "100.64.0.10", { tailnetIpv4Addresses: [] }),
        node("twin", "100.64.0.6"),
        node("silent", "100.64.0.11", { magicDnsName: null }),
      ],
    },
    {
      "https://beta.tail.ts.net/.well-known/t3/environment": descriptor("env-beta", "Beta"),
      "http://100.64.0.4:3773/.well-known/t3/environment": descriptor("env-beta", "Beta"),
      [`http://100.64.0.5:${SERVER_PORT}/.well-known/t3/environment`]: descriptor(
        "env-alpha",
        "Alpha",
      ),
      "https://twin.tail.ts.net/.well-known/t3/environment": descriptor(OWN_ENVIRONMENT_ID, "Me"),
    },
  );

  return Effect.gen(function* () {
    assert.deepEqual(yield* peers, {
      available: true,
      peers: [
        {
          name: "alpha",
          magicDnsName: "alpha.tail.ts.net",
          tailnetAddress: "100.64.0.5",
          os: "linux",
          online: true,
          environmentId: EnvironmentId.make("env-alpha"),
          label: "Alpha",
          httpBaseUrl: `http://100.64.0.5:${SERVER_PORT}/`,
        },
        {
          name: "beta",
          magicDnsName: "beta.tail.ts.net",
          tailnetAddress: "100.64.0.4",
          os: "linux",
          online: true,
          environmentId: EnvironmentId.make("env-beta"),
          label: "Beta",
          httpBaseUrl: "https://beta.tail.ts.net/",
        },
      ],
    });
    const probedHosts = new Set(probed.map((url) => new URL(url).hostname));
    assert.deepEqual(
      [...probedHosts].toSorted(),
      [
        "100.64.0.4",
        "100.64.0.5",
        "100.64.0.6",
        "100.64.0.11",
        "alpha.tail.ts.net",
        "beta.tail.ts.net",
        "twin.tail.ts.net",
      ].toSorted(),
    );
  }).pipe(Effect.provide(layer));
});

it.effect("reports Tailscale as unavailable without probing", () => {
  const { probed, layer } = makeHarness(null, {});
  return Effect.gen(function* () {
    assert.deepEqual(yield* peers, { available: false, peers: [] });
    assert.deepEqual(probed, []);
  }).pipe(Effect.provide(layer));
});

it.effect("reuses a recent result instead of probing again", () => {
  const { probed, layer } = makeHarness(
    { running: true, self: null, peers: [node("beta", "100.64.0.4")] },
    {},
  );
  return Effect.gen(function* () {
    yield* peers;
    const firstRound = probed.length;
    assert.isAbove(firstRound, 0);
    yield* peers;
    assert.equal(probed.length, firstRound);
    yield* TestClock.adjust("31 seconds");
    yield* peers;
    assert.equal(probed.length, firstRound * 2);
  }).pipe(Effect.provide(layer));
});

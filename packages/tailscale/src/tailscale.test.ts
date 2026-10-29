import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  ensureTailscaleServe,
  parseTailscaleExitNode,
  parseTailscaleSshEnabled,
  parseTailscaleStatus,
  parseTailscaleTailnet,
  parseTailscaleWhois,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  readTailscaleWhois,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
  );
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return layerSpawner(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

const OWNER_ID = 7478531525256488;
const TAGGED_DEVICES_ID = 343712290915616;
const tailnetUsers = {
  [String(OWNER_ID)]: { ID: OWNER_ID, LoginName: "seatedro@github" },
  [String(TAGGED_DEVICES_ID)]: { ID: TAGGED_DEVICES_ID, LoginName: "tagged-devices" },
};
const pulsarStatusNode = {
  ID: "nLppMTC8Q711CNTRL",
  HostName: "pulsar",
  DNSName: "pulsar.tail87c919.ts.net.",
  OS: "linux",
  UserID: OWNER_ID,
  TailscaleIPs: ["100.84.4.32", "fd7a:115c:a1e0::5a29:421"],
  Tags: null,
  Online: true,
};
const pulsarNode = {
  stableId: "nLppMTC8Q711CNTRL",
  name: "pulsar",
  magicDnsName: "pulsar.tail87c919.ts.net",
  os: "linux",
  userId: OWNER_ID,
  loginName: "seatedro@github",
  tagged: false,
  tailnetIpv4Addresses: ["100.84.4.32"],
  tailnetAddresses: ["100.84.4.32", "fd7a:115c:a1e0::5a29:421"],
  online: true,
  sharee: false,
};
const macbookWhois = {
  Node: {
    ID: 6140258256360914,
    StableID: "n5xhnzAwwp11CNTRL",
    Name: "macbook.tail87c919.ts.net.",
    ComputedName: "macbook",
    User: OWNER_ID,
    Tags: null,
    Addresses: ["100.117.108.54/32", "fd7a:115c:a1e0::2533:6c36/128"],
    AllowedIPs: ["100.117.108.54/32", "fd7a:115c:a1e0::2533:6c36/128"],
    Hostinfo: { OS: "macOS" },
  },
  UserProfile: { ID: OWNER_ID, LoginName: "seatedro@github", DisplayName: "rohit" },
};

describe("tailscale", () => {
  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
        httpsServeEnabled: null,
      });
    }),
  );

  it.effect("names the exit node in use", () =>
    Effect.gen(function* () {
      const inUse = yield* parseTailscaleExitNode(
        JSON.stringify({
          ExitNodeStatus: { ID: "nX", Online: true, TailscaleIPs: ["100.101.102.103/32"] },
          Peer: {
            "nodekey:a": { HostName: "laptop", DNSName: "laptop.tail.ts.net.", ExitNode: false },
            "nodekey:b": {
              HostName: "raspberrypi",
              DNSName: "home-pi.tail.ts.net.",
              ExitNode: true,
            },
          },
        }),
      );
      assert.deepEqual(inUse, { name: "home-pi", online: true });

      const unnamed = yield* parseTailscaleExitNode(`{"ExitNodeStatus":{"Online":false}}`);
      assert.deepEqual(unnamed, { name: null, online: false });

      assert.equal(yield* parseTailscaleExitNode(tailscaleStatusJson), null);
    }),
  );

  it.effect("reads the HTTPS serve capability from the status capability map", () =>
    Effect.gen(function* () {
      const enabled = yield* parseTailscaleStatus(
        `{"Self":{"CapMap":{"https":null,"funnel":null}}}`,
      );
      assert.equal(enabled.httpsServeEnabled, true);

      const disabled = yield* parseTailscaleStatus(`{"Self":{"CapMap":{"funnel":null}}}`);
      assert.equal(disabled.httpsServeEnabled, false);
    }),
  );

  it.effect("parses the tailnet from status", () =>
    Effect.gen(function* () {
      const tailnet = yield* parseTailscaleTailnet(
        JSON.stringify({
          BackendState: "Running",
          Self: pulsarStatusNode,
          Peer: {
            "nodekey:tagged": {
              ID: "nTagged",
              HostName: "builder",
              DNSName: "builder.tail87c919.ts.net.",
              OS: "linux",
              UserID: TAGGED_DEVICES_ID,
              TailscaleIPs: ["100.70.0.2/32", "fd7a:115c:a1e0::2"],
              Tags: ["tag:codex-target"],
              Online: false,
            },
            "nodekey:sharee": {
              ID: "nSharee",
              HostName: "Friend's Mac",
              OS: "macOS",
              UserID: 99,
              TailscaleIPs: ["fd7a:115c:a1e0::3"],
              Online: true,
              ShareeNode: true,
            },
          },
          User: tailnetUsers,
        }),
      );
      assert.deepEqual(tailnet, {
        running: true,
        self: pulsarNode,
        peers: [
          {
            stableId: "nTagged",
            name: "builder",
            magicDnsName: "builder.tail87c919.ts.net",
            os: "linux",
            userId: TAGGED_DEVICES_ID,
            loginName: null,
            tagged: true,
            tailnetIpv4Addresses: ["100.70.0.2"],
            tailnetAddresses: ["100.70.0.2", "fd7a:115c:a1e0::2"],
            online: false,
            sharee: false,
          },
          {
            stableId: "nSharee",
            name: "Friend's Mac",
            magicDnsName: null,
            os: "macOS",
            userId: 99,
            loginName: null,
            tagged: false,
            tailnetIpv4Addresses: [],
            tailnetAddresses: ["fd7a:115c:a1e0::3"],
            online: true,
            sharee: true,
          },
        ],
      });
    }),
  );

  it.effect("parses a tailnet that is not running or sparse", () =>
    Effect.gen(function* () {
      for (const [statusJson, expected] of [
        [
          { BackendState: "NeedsLogin", Self: pulsarStatusNode, User: tailnetUsers },
          { running: false, self: pulsarNode, peers: [] },
        ],
        [{}, { running: false, self: null, peers: [] }],
        [
          { BackendState: "Running", Self: {} },
          {
            running: true,
            self: {
              stableId: null,
              name: null,
              magicDnsName: null,
              os: null,
              userId: null,
              loginName: null,
              tagged: false,
              tailnetIpv4Addresses: [],
              tailnetAddresses: [],
              online: false,
              sharee: false,
            },
            peers: [],
          },
        ],
        // A user id missing from the User map leaves the login unknown.
        [
          { BackendState: "Running", Self: pulsarStatusNode },
          { running: true, self: { ...pulsarNode, loginName: null }, peers: [] },
        ],
      ] as const) {
        assert.deepEqual(yield* parseTailscaleTailnet(JSON.stringify(statusJson)), expected);
      }
      const error = yield* parseTailscaleTailnet("{not-json").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    }),
  );

  it.effect("parses whois identities", () =>
    Effect.gen(function* () {
      const macbook = {
        stableId: "n5xhnzAwwp11CNTRL",
        name: "macbook",
        magicDnsName: "macbook.tail87c919.ts.net",
        os: "macOS",
        userId: OWNER_ID,
        loginName: "seatedro@github",
        tagged: false,
        shared: false,
        routesOtherHosts: false,
      };
      for (const [whoisJson, expected] of [
        [macbookWhois, macbook],
        [{ ...macbookWhois, Node: { ...macbookWhois.Node, Sharer: 0 } }, macbook],
        [
          { ...macbookWhois, Node: { ...macbookWhois.Node, Sharer: 12345 } },
          { ...macbook, shared: true },
        ],
        [
          {
            Node: {
              ...macbookWhois.Node,
              User: TAGGED_DEVICES_ID,
              Tags: ["tag:codex-target"],
            },
            UserProfile: { ID: TAGGED_DEVICES_ID, LoginName: "tagged-devices" },
          },
          { ...macbook, userId: TAGGED_DEVICES_ID, loginName: null, tagged: true },
        ],
        [
          { ...macbookWhois, UserProfile: { ...macbookWhois.UserProfile, ID: 1 } },
          { ...macbook, loginName: null },
        ],
        [{ Node: macbookWhois.Node }, { ...macbook, loginName: null }],
        // An exit node or subnet router speaks for the hosts behind it.
        [
          {
            ...macbookWhois,
            Node: {
              ...macbookWhois.Node,
              AllowedIPs: [...macbookWhois.Node.AllowedIPs, "0.0.0.0/0", "::/0"],
            },
          },
          { ...macbook, routesOtherHosts: true },
        ],
        [
          {
            ...macbookWhois,
            Node: {
              ...macbookWhois.Node,
              AllowedIPs: [...macbookWhois.Node.AllowedIPs, "192.168.1.0/24"],
              PrimaryRoutes: ["192.168.1.0/24"],
            },
          },
          { ...macbook, routesOtherHosts: true },
        ],
        [
          {
            ...macbookWhois,
            Node: { ...macbookWhois.Node, AllowedIPs: ["100.117.108.54/24"] },
          },
          { ...macbook, routesOtherHosts: true },
        ],
      ] as const) {
        assert.deepEqual(yield* parseTailscaleWhois(JSON.stringify(whoisJson)), expected);
      }
    }),
  );

  it.effect("reads whois and treats an unknown peer as null", () =>
    Effect.gen(function* () {
      const known = layerMockSpawner((command, args) => {
        assert.equal(command, "tailscale");
        assert.deepEqual(args, ["whois", "--json", "100.101.0.7"]);
        return { stdout: JSON.stringify(macbookWhois) };
      });
      const whois = yield* readTailscaleWhois("100.101.0.7").pipe(Effect.provide(known));
      assert.equal(whois?.loginName, "seatedro@github");

      const unknown = layerMockSpawner(() => ({ code: 1, stderr: "peer not found\n" }));
      assert.equal(yield* readTailscaleWhois("100.101.0.8").pipe(Effect.provide(unknown)), null);

      const failing = layerMockSpawner(() => ({ code: 1, stderr: "not logged in" }));
      const error = yield* readTailscaleWhois("100.101.0.8").pipe(
        Effect.flip,
        Effect.provide(failing),
      );
      assert.instanceOf(error, TailscaleCommandExitError);
    }),
  );

  it.effect("reads Tailscale SSH enablement from local prefs", () => {
    const prefsJson =
      '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": true,\n\t"WantRunning": true\n}\n';
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["debug", "prefs"]);
      return { stdout: prefsJson };
    });

    return Effect.gen(function* () {
      assert.isTrue(yield* readTailscaleSshEnabled.pipe(Effect.provide(layer)));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":false,"WantRunning":true}'));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":true,"WantRunning":false}'));
      assert.isFalse(yield* parseTailscaleSshEnabled("{}"));
      const error = yield* parseTailscaleSshEnabled("{not-json").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = layerSpawner(
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      const degraded = yield* readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = layerMockSpawner(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  // regression: #21609 - without forceKillAfter a timed-out probe only gets
  // SIGTERM, so a group member that ignores it outlives the call.
  it.effect("escalates timed-out probes to SIGKILL", () => {
    const killGraces: Array<number | undefined> = [];
    const layer = layerSpawner(
      ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          const { forceKillAfter } = command.options;
          killGraces.push(
            forceKillAfter === undefined
              ? undefined
              : Duration.toMillis(Duration.fromInputUnsafe(forceKillAfter)),
          );
        }
        return Effect.succeed(mockHandle({ stdout: "{}" }));
      }),
    );

    return Effect.gen(function* () {
      yield* readTailscaleStatus.pipe(Effect.provide(layer));
      yield* readTailscaleSshEnabled.pipe(Effect.provide(layer));
      assert.deepEqual(killGraces, [500, 500]);
    });
  });
});

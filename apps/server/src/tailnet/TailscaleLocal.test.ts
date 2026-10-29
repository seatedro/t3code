import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as TailscaleLocal from "./TailscaleLocal.ts";

const encoder = new TextEncoder();
const WHOIS = JSON.stringify({
  Node: {
    StableID: "nMacbook",
    Name: "macbook.tail87c919.ts.net.",
    User: 1,
    Addresses: ["100.117.108.54/32"],
    AllowedIPs: ["100.117.108.54/32"],
  },
  UserProfile: { ID: 1, LoginName: "owner@github" },
});
const STATUS = JSON.stringify({ BackendState: "Running", Self: { ID: "nPulsar" } });

/** Every `tailscale` it starts stays running until released, and it counts how many overlap. */
const makeSpawner = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const twoRunning = yield* Deferred.make<void>();
  const running = yield* Ref.make(0);
  const peak = yield* Ref.make(0);
  const started = yield* Ref.make<ReadonlyArray<string>>([]);
  const spawner = ChildProcessSpawner.make((command) => {
    const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args;
    return Effect.gen(function* () {
      yield* Ref.update(started, (all) => [...all, args.join(" ")]);
      const now = yield* Ref.updateAndGet(running, (count) => count + 1);
      yield* Ref.update(peak, (max) => Math.max(max, now));
      if (now === 2) yield* Deferred.succeed(twoRunning, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(release).pipe(
          Effect.ensuring(Ref.update(running, (count) => count - 1)),
          Effect.as(ChildProcessSpawner.ExitCode(0)),
        ),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(args[0] === "whois" ? WHOIS : STATUS)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    });
  });
  const layer = TailscaleLocal.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
  );
  return { release, twoRunning, peak, started, layer };
});

it.effect("runs at most two tailscale processes and refuses more at once", () =>
  Effect.gen(function* () {
    const { release, twoRunning, peak, started, layer } = yield* makeSpawner;
    yield* Effect.gen(function* () {
      const tailscale = yield* TailscaleLocal.TailscaleLocal;
      const first = yield* Effect.forkChild(tailscale.whois("100.64.0.1"));
      const second = yield* Effect.forkChild(tailscale.whois("100.64.0.2"));
      // Both slots are held until released, so a third address is turned away, not queued.
      yield* Deferred.await(twoRunning);
      expect(yield* Effect.flip(tailscale.whois("100.64.0.3"))).toMatchObject({
        _tag: "TailscaleLocalBusyError",
      });
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(first))?.loginName).toBe("owner@github");
      expect((yield* Fiber.join(second))?.loginName).toBe("owner@github");
      expect(yield* Ref.get(peak)).toBe(2);
      expect((yield* Ref.get(started)).length).toBe(2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("shares whois and status answers within their window", () =>
  Effect.gen(function* () {
    const { release, started, layer } = yield* makeSpawner;
    yield* Deferred.succeed(release, undefined);
    yield* Effect.gen(function* () {
      const tailscale = yield* TailscaleLocal.TailscaleLocal;
      yield* Effect.all([tailscale.tailnet, tailscale.tailnet, tailscale.tailnet], {
        concurrency: "unbounded",
      });
      yield* tailscale.whois("100.64.0.1");
      yield* tailscale.whois("100.64.0.1");
      expect(yield* Ref.get(started)).toEqual(["status --json", "whois --json 100.64.0.1"]);
      yield* TestClock.adjust("6 seconds");
      yield* tailscale.tailnet;
      yield* tailscale.whois("100.64.0.1");
      expect((yield* Ref.get(started)).length).toBe(4);
    }).pipe(Effect.provide(layer));
  }),
);

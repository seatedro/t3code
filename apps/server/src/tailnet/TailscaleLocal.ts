import {
  readTailscaleTailnet,
  readTailscaleWhois,
  type TailscaleTailnet,
  type TailscaleWhois,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Tailnet peers can each make the server ask; this bounds the `tailscale` processes alive at once. */
const MAX_CONCURRENT_COMMANDS = 2;
/** Long enough that a burst of requests shares one `tailscale status`, short enough to follow changes. */
const STATUS_TTL = Duration.seconds(5);

/** What this machine's tailscaled reports. Unavailable Tailscale reads as null, never as an error. */
export class TailscaleLocal extends Context.Service<
  TailscaleLocal,
  {
    readonly tailnet: Effect.Effect<TailscaleTailnet | null>;
    /** Never cached: who holds an address is the answer an admission depends on. */
    readonly whois: (address: string) => Effect.Effect<TailscaleWhois | null>;
  }
>()("t3/tailnet/TailscaleLocal") {}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commands = yield* Semaphore.make(MAX_CONCURRENT_COMMANDS);
  const unavailable = (operation: string) => (cause: unknown) =>
    Effect.logDebug("Tailscale is unavailable.", { operation, cause }).pipe(Effect.as(null));

  const tailnet = yield* Effect.cachedWithTTL(
    readTailscaleTailnet.pipe(
      Effect.map((status) => (status.running ? status : null)),
      Effect.catch(unavailable("status")),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      commands.withPermits(1),
      Effect.withSpan("TailscaleLocal.tailnet"),
    ),
    STATUS_TTL,
  );

  return TailscaleLocal.of({
    tailnet,
    whois: Effect.fn("TailscaleLocal.whois")(function* (address) {
      return yield* readTailscaleWhois(address).pipe(
        Effect.catch(unavailable("whois")),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        commands.withPermits(1),
      );
    }),
  });
});

export const layer = Layer.effect(TailscaleLocal, make);

import {
  readTailscaleTailnet,
  readTailscaleWhois,
  type TailscaleTailnet,
  type TailscaleWhois,
} from "@t3tools/tailscale";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Tailnet peers can each make the server ask; this bounds the `tailscale` processes alive at once. */
const MAX_CONCURRENT_COMMANDS = 2;
/** Long enough that a burst shares one answer, short enough to follow changes. */
const STATUS_TTL = Duration.seconds(5);
const WHOIS_TTL = Duration.seconds(5);
const WHOIS_CACHE_CAPACITY = 512;

/** Both `tailscale` slots were taken, so this question was not asked. */
export class TailscaleLocalBusyError extends Schema.TaggedError<TailscaleLocalBusyError>()(
  "TailscaleLocalBusyError",
  {},
) {
  override get message(): string {
    return "Tailscale is busy answering other requests.";
  }
}

/** What this machine's tailscaled reports. Unavailable Tailscale reads as null. */
export class TailscaleLocal extends Context.Service<
  TailscaleLocal,
  {
    readonly tailnet: Effect.Effect<TailscaleTailnet | null>;
    /** Who holds an address, remembered briefly, refusals included. Fails fast when busy. */
    readonly whois: (
      address: string,
    ) => Effect.Effect<TailscaleWhois | null, TailscaleLocalBusyError>;
  }
>()("t3/tailnet/TailscaleLocal") {}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commands = yield* Semaphore.make(MAX_CONCURRENT_COMMANDS);
  const unavailable = (operation: string) => (cause: unknown) =>
    Effect.logDebug("Tailscale is unavailable.", { operation, cause }).pipe(Effect.as(null));

  // One `tailscale status` at a time: callers within the window share it.
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

  // Concurrent asks for one address share a lookup; a busy refusal is not remembered.
  const whoisCache = yield* Cache.makeWith(
    (address: string) =>
      readTailscaleWhois(address).pipe(
        Effect.catch(unavailable("whois")),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        commands.withPermitsIfAvailable(1),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new TailscaleLocalBusyError({})),
            onSome: Effect.succeed,
          }),
        ),
      ),
    {
      capacity: WHOIS_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? WHOIS_TTL : Duration.zero),
    },
  );

  return TailscaleLocal.of({
    tailnet,
    whois: Effect.fn("TailscaleLocal.whois")(function* (address) {
      return yield* Cache.get(whoisCache, address);
    }),
  });
});

export const layer = Layer.effect(TailscaleLocal, make);

import {
  readTailscaleTailnet,
  readTailscaleWhois,
  type TailscaleTailnet,
  type TailscaleWhois,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** What this machine's tailscaled reports. Unavailable Tailscale reads as null, never as an error. */
export class TailscaleLocal extends Context.Service<
  TailscaleLocal,
  {
    readonly tailnet: Effect.Effect<TailscaleTailnet | null>;
    readonly whois: (address: string) => Effect.Effect<TailscaleWhois | null>;
  }
>()("t3/tailnet/TailscaleLocal") {}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const unavailable = (operation: string) => (cause: unknown) =>
    Effect.logDebug("Tailscale is unavailable.", { operation, cause }).pipe(Effect.as(null));

  return TailscaleLocal.of({
    tailnet: readTailscaleTailnet.pipe(
      Effect.map((tailnet) => (tailnet.running ? tailnet : null)),
      Effect.catch(unavailable("status")),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.withSpan("TailscaleLocal.tailnet"),
    ),
    whois: Effect.fn("TailscaleLocal.whois")(function* (address) {
      return yield* readTailscaleWhois(address).pipe(
        Effect.catch(unavailable("whois")),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    }),
  });
});

export const layer = Layer.effect(TailscaleLocal, make);

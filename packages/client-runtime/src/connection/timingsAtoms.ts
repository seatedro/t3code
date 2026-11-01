// temp: connection timings. Round trips are measured only while a timings panel is open.
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionTimings from "./timings.ts";
import { followStreamInEnvironment } from "../state/environmentStreams.ts";

const ROUND_TRIP_INTERVAL = "15 seconds";
const ROUND_TRIP_TIMEOUT = "10 seconds";

const measureRoundTrip = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) return;
  const prepared = Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared));
  const startedAt = performance.now();
  // `server.probe` is the cheapest request a server answers: it replies with `{}`.
  const exit = yield* session.value.probe.pipe(Effect.timeout(ROUND_TRIP_TIMEOUT), Effect.exit);
  const ms = performance.now() - startedAt;
  ConnectionTimings.recordRoundTrip(
    environmentId,
    prepared,
    Exit.isSuccess(exit) ? { ms } : { error: String(Cause.squash(exit.cause)) },
  );
});

/**
 * Mounting an environment's atom measures its round trip now and every 15 seconds until it
 * unmounts. Refreshing it measures again.
 */
export function createConnectionRoundTripAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.tick(ROUND_TRIP_INTERVAL).pipe(
            Stream.mapEffect(() => measureRoundTrip(environmentId)),
          ),
        ),
      )
      .pipe(Atom.withLabel(`connection-round-trip:${environmentId}`)),
  );
}

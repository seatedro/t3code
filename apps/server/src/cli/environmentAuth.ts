import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import { GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/** Runs against the environment's own database, whether or not its server is running. */
export const runWithEnvironmentAuth = Effect.fn("auth.runWithEnvironmentAuth")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* run(environmentAuth);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

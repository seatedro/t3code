import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type * as DesktopBackendManager from "./DesktopBackendManager.ts";

const ATTACH_TIMEOUT = Duration.seconds(15);
const DESCRIPTOR_TIMEOUT_MS = 2_000;

const OwnerRuntimeState = Schema.Struct({
  origin: Schema.String,
  serverVersion: Schema.optional(Schema.String),
});
const decodeOwnerRuntimeState = Schema.decodeEffect(Schema.fromJsonString(OwnerRuntimeState));

const IssuedPairingCredential = Schema.Struct({ credential: Schema.NonEmptyString });
const decodeIssuedPairingCredential = Schema.decodeEffect(
  Schema.fromJsonString(IssuedPairingCredential),
);

export interface StateDirOwnerPaths {
  readonly runtimeStatePath: string;
  readonly environmentIdPath: string;
  readonly serverVersion: string;
}

/**
 * Resolve a start config that attaches to the server already owning this T3 home.
 * Only an owner on exactly this server version with this home's environment id qualifies,
 * so the bundled CLI can mint its pairing credential without migrating the live database.
 */
export const resolveAttachConfig = Effect.fn("desktop.stateDirOwner.resolveAttachConfig")(
  function* (config: DesktopBackendManager.DesktopBackendStartConfig, paths: StateDirOwnerPaths) {
    const baseDir = config.bootstrap.t3Home;
    const entryIndex = config.args.indexOf(config.entryPath);
    // WSL owners live in the distro's filesystem, which this process cannot inspect.
    if (config.runningDistro !== undefined || baseDir === undefined || entryIndex === -1) {
      return Option.none<DesktopBackendManager.DesktopBackendStartConfig>();
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const owner = yield* fileSystem
      .readFileString(paths.runtimeStatePath)
      .pipe(Effect.flatMap(decodeOwnerRuntimeState));
    if (owner.serverVersion !== paths.serverVersion) {
      yield* Effect.logWarning("T3 home owner runs a different server version; not attaching", {
        ownerVersion: owner.serverVersion ?? null,
        desktopVersion: paths.serverVersion,
      });
      return Option.none();
    }
    const httpBaseUrl = new URL(owner.origin);
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: httpBaseUrl.href,
      timeoutMs: DESCRIPTOR_TIMEOUT_MS,
    });
    const environmentId = (yield* fileSystem.readFileString(paths.environmentIdPath)).trim();
    if (
      descriptor.serverVersion !== paths.serverVersion ||
      descriptor.environmentId !== environmentId
    ) {
      yield* Effect.logWarning(
        "server at the T3 home owner's origin does not match; not attaching",
        {
          origin: owner.origin,
          serverVersion: descriptor.serverVersion,
        },
      );
      return Option.none();
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* spawner.string(
      ChildProcess.make(
        config.executablePath,
        [
          ...config.args.slice(0, entryIndex + 1),
          "auth",
          "pairing",
          "create",
          "--base-dir",
          baseDir,
          "--label",
          "T3 Code Desktop",
          "--json",
        ],
        {
          cwd: config.cwd,
          env: config.env,
          extendEnv: config.extendEnv,
          stdin: "ignore",
        },
      ),
    );
    const { credential } = yield* decodeIssuedPairingCredential(
      output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1),
    );
    const { desktopBootstrapSecret: _ownSecret, ...bootstrap } = config.bootstrap;
    return Option.some<DesktopBackendManager.DesktopBackendStartConfig>({
      ...config,
      httpBaseUrl,
      bootstrap: { ...bootstrap, desktopBootstrapToken: credential },
    });
  },
  (effect) =>
    effect.pipe(
      Effect.timeout(ATTACH_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not attach to the T3 home owner", { cause }).pipe(
          Effect.as(Option.none<DesktopBackendManager.DesktopBackendStartConfig>()),
        ),
      ),
    ),
);

export type StateDirOwnerRequirements =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

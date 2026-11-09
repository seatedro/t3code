import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopStateDirOwner from "./DesktopStateDirOwner.ts";

const config: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["--require", "/cache.cjs", "/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  extendEnv: true,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    t3Home: "/home/me/.t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "own-token",
    desktopBootstrapSecret: "own-secret",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

const paths: DesktopStateDirOwner.StateDirOwnerPaths = {
  runtimeStatePath: "/home/me/.t3/userdata/server-runtime.json",
  environmentIdPath: "/home/me/.t3/userdata/environment-id",
  serverVersion: "0.1.8",
};

const run = (owner: {
  readonly runtimeVersion: string;
  readonly descriptorVersion: string;
  readonly descriptorEnvironmentId: string;
}) =>
  Effect.gen(function* () {
    const commands: Array<ChildProcess.StandardCommand> = [];
    const files: Record<string, string> = {
      [paths.runtimeStatePath]: JSON.stringify({
        version: 1,
        pid: 42,
        port: 3773,
        origin: "http://127.0.0.1:3773",
        startedAt: "2026-11-09T00:00:00.000Z",
        serverVersion: owner.runtimeVersion,
      }),
      [paths.environmentIdPath]: "env-home\n",
    };
    const result = yield* DesktopStateDirOwner.resolveAttachConfig(config, paths).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            readFileString: (path) =>
              path in files
                ? Effect.succeed(files[path]!)
                : Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "readFileString",
                      pathOrDescriptor: path,
                    }),
                  ),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    environmentId: owner.descriptorEnvironmentId,
                    label: "forge",
                    platform: { os: "linux", arch: "x64" },
                    serverVersion: owner.descriptorVersion,
                    capabilities: { repositoryIdentity: true },
                  }),
                ),
              ),
            ),
          ),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.sync(() => {
                if (command._tag === "StandardCommand") commands.push(command);
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(7),
                  stdout: Stream.make(
                    new TextEncoder().encode(
                      `{\n  "id": "p1",\n  "credential": "minted-credential"\n}\n`,
                    ),
                  ),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void),
                });
              }),
            ),
          ),
        ),
      ),
    );
    return { result, commands };
  });

describe("DesktopStateDirOwner.resolveAttachConfig", () => {
  it.effect("attaches to a same-version owner of this home with a minted credential", () =>
    Effect.gen(function* () {
      const { result, commands } = yield* run({
        runtimeVersion: "0.1.8",
        descriptorVersion: "0.1.8",
        descriptorEnvironmentId: "env-home",
      });
      assert.isTrue(Option.isSome(result));
      const attached = Option.getOrThrow(result);
      assert.equal(attached.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.equal(attached.bootstrap.desktopBootstrapToken, "minted-credential");
      // The owner never saw this desktop's secret, so rotating tokens must not be derived from it.
      assert.isUndefined(attached.bootstrap.desktopBootstrapSecret);
      assert.deepEqual(commands[0]?.args, [
        "--require",
        "/cache.cjs",
        "/server/bin.mjs",
        "auth",
        "pairing",
        "create",
        "--base-dir",
        "/home/me/.t3",
        "--label",
        "T3 Code Desktop",
        "--json",
      ]);
    }),
  );

  it.effect("refuses owners that are not this version or not this home's environment", () =>
    Effect.gen(function* () {
      for (const owner of [
        {
          runtimeVersion: "0.1.7",
          descriptorVersion: "0.1.7",
          descriptorEnvironmentId: "env-home",
        },
        {
          runtimeVersion: "0.1.8",
          descriptorVersion: "0.1.9",
          descriptorEnvironmentId: "env-home",
        },
        {
          runtimeVersion: "0.1.8",
          descriptorVersion: "0.1.8",
          descriptorEnvironmentId: "env-other",
        },
      ]) {
        const { result, commands } = yield* run(owner);
        assert.isTrue(Option.isNone(result), JSON.stringify(owner));
        assert.equal(commands.length, 0);
      }
    }),
  );
});

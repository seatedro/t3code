import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type {
  VcsDriverKind,
  VcsError,
  VcsRepositoryIdentity,
  VcsWorkspaceProblem,
} from "@t3tools/contracts";
import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as JjCli from "./jj/JjCli.ts";
import * as JjVcsDriver from "./jj/JjVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
// Detection costs three git processes per cwd; cached hits still stat disk, so TTL bounds only undetectable changes.
const DETECTION_CACHE_TTL = Duration.minutes(5);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
  /** Set when the repository is recognized but T3 Code cannot drive it (for example, a non-colocated jj repo). */
  readonly problem?: VcsWorkspaceProblem;
}

interface DetectionDiskState {
  readonly markerEntries: ReadonlyArray<boolean>;
  readonly jjVersion: string | null;
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
  }
>()("t3/vcs/VcsDriverRegistry") {}

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return {
      cwd: key,
      requestedKind: "auto",
    };
  }
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const git = yield* GitVcsDriver.makeVcsDriver;
  const jjCli = yield* JjCli.make;
  const jj = VcsDriver.VcsDriver.of(
    yield* JjVcsDriver.makeVcsDriverShape(git).pipe(Effect.provideService(JjCli.JjCli, jjCli)),
  );
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriver["Service"]>> = {
    git,
    jj,
  };

  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    const problem =
      kind === "jj"
        ? yield* JjVcsDriver.inspectSupport(repository.rootPath).pipe(
            Effect.provideService(JjCli.JjCli, jjCli),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          )
        : null;
    return {
      kind,
      repository,
      driver,
      ...(problem ? { problem } : {}),
    } satisfies VcsDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    // At the same root `.jj` wins; a jj repo never falls back to Git, even when it is unsupported.
    return (
      (yield* detectWithDriver("jj", jj, input.cwd)) ??
      (yield* detectWithDriver("git", git, input.cwd))
    );
  });

  // Symlinks can put cwd outside root; then inspect cwd alone.
  const foldersBelowRoot = (cwd: string, rootPath: string) => {
    const relative = path.relative(path.resolve(rootPath), path.resolve(cwd));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return [cwd];
    return Array.from({ length: relative.split(path.sep).length }, (_, levelsUp) =>
      path.resolve(cwd, ...Array<string>(levelsUp).fill("..")),
    );
  };

  // A changed jj version can change whether a jj repository is supported.
  const readDiskState = (cwd: string, handle: VcsDriverHandle) =>
    Effect.all({
      markerEntries: Effect.forEach(
        [
          ...new Set([
            ...foldersBelowRoot(cwd, handle.repository.rootPath),
            handle.repository.rootPath,
          ]),
        ],
        (folder) =>
          Effect.all([
            fileSystem.exists(path.join(folder, ".git")),
            fileSystem.exists(path.join(folder, ".jj")),
          ]),
      ).pipe(Effect.map((entries) => entries.flat())),
      repositoryOnDisk: Effect.forEach(
        handle.repository.metadataPath === null
          ? [cwd]
          : [cwd, path.resolve(cwd, handle.repository.metadataPath)],
        (target) => fileSystem.exists(target),
      ).pipe(Effect.map((results) => results.every(Boolean))),
      jjVersion:
        handle.kind === "jj"
          ? jjCli.version.pipe(
              Effect.map((version) => version.raw),
              Effect.orElseSucceed(() => null),
            )
          : Effect.succeed(null),
    }).pipe(Effect.orElseSucceed(() => null));

  const sameDiskState = (
    cached: DetectionDiskState,
    disk: (DetectionDiskState & { readonly repositoryOnDisk: boolean }) | null,
  ) =>
    disk !== null &&
    disk.repositoryOnDisk &&
    disk.jjVersion === cached.jjVersion &&
    disk.markerEntries.length === cached.markerEntries.length &&
    disk.markerEntries.every((exists, index) => exists === cached.markerEntries[index]);

  const detectionCache = yield* Cache.makeWith<
    string,
    (DetectionDiskState & { readonly handle: VcsDriverHandle }) | null,
    VcsError
  >(
    (key) =>
      Effect.gen(function* () {
        const input = parseDetectionCacheKey(key);
        const handle = yield* detectResolvedKind(input);
        if (handle === null) return null;
        const disk = yield* readDiskState(input.cwd, handle);
        return {
          handle,
          markerEntries: disk?.markerEntries ?? [],
          jjVersion: disk?.jjVersion ?? null,
        };
      }),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) =>
          detected === null || detected.handle.problem?.code === "error"
            ? Duration.zero
            : DETECTION_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = yield* projectConfig.resolveKind(input);
      const key = detectionCacheKey({ cwd: input.cwd, requestedKind });
      const cached = yield* Cache.get(detectionCache, key);
      if (cached === null) return null;
      if (sameDiskState(cached, yield* readDiskState(input.cwd, cached.handle))) {
        return cached.handle;
      }
      yield* Cache.invalidate(detectionCache, key);
      return (yield* Cache.get(detectionCache, key))?.handle ?? null;
    },
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsDriverRegistry.resolve",
        kind: requestedKind === "auto" ? "unknown" : requestedKind,
        detail:
          requestedKind === "auto"
            ? `No supported VCS repository was detected at ${input.cwd}.`
            : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      });
    },
  );

  return VcsDriverRegistry.of({
    get,
    detect,
    resolve,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);

// @effect-diagnostics-next-line nodeBuiltinImport:off - suites gate on jj synchronously at collection time.
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

// CI does not install jj yet; suites gate on this instead of failing.
export const jjAvailable =
  NodeChildProcess.spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;

const ISOLATED_ENV_KEYS = [
  "JJ_CONFIG",
  "JJ_USER",
  "JJ_EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/**
 * Points jj and Git at an empty config for the layer's lifetime so the developer's
 * own config, aliases, and identity never reach the code under test.
 */
export const layerIsolatedEnv = Layer.effectDiscard(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-env-" });
    const jjConfig = path.join(directory, "jj-config.toml");
    const gitConfig = path.join(directory, "gitconfig");
    yield* fileSystem.writeFileString(jjConfig, "");
    yield* fileSystem.writeFileString(gitConfig, "");
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Object.fromEntries(
          ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
        );
        Object.assign(process.env, {
          JJ_CONFIG: jjConfig,
          JJ_USER: "T3 Test",
          JJ_EMAIL: "test@t3.invalid",
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_CONFIG_NOSYSTEM: "1",
        });
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          for (const key of ISOLATED_ENV_KEYS) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
  }),
);

// A failed fixture command is a broken test setup, so it dies with the command's stderr.
const run = (command: "jj" | "git", cwd: string, args: ReadonlyArray<string>) =>
  Effect.sync(() =>
    NodeChildProcess.execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

export const runJj = (cwd: string, args: ReadonlyArray<string>) => run("jj", cwd, args);
export const runGit = (cwd: string, args: ReadonlyArray<string>) => run("git", cwd, args);

export const writeFile = Effect.fn("JjFixture.writeFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

/** `cwd` must exist; it becomes the root of a colocated repository's default workspace. */
export const createColocatedRepo = (cwd: string) =>
  runJj(cwd, ["git", "init", "--colocate"]).pipe(Effect.asVoid);

export const createNonColocatedRepo = (cwd: string) =>
  runJj(cwd, ["git", "init", "--no-colocate"]).pipe(Effect.asVoid);

/** Adds a colocated secondary workspace at `destination`, whose parent must exist. */
export const addWorkspace = (repoRoot: string, name: string, destination: string) =>
  runJj(repoRoot, ["workspace", "add", "--colocate", "--name", name, destination]).pipe(
    Effect.asVoid,
  );

/** Rewrites the workspace's working-copy commit from `repoRoot` so the workspace goes stale. */
export const makeWorkspaceStale = Effect.fn("JjFixture.makeWorkspaceStale")(function* (
  repoRoot: string,
  workspaceName: string,
) {
  yield* writeFile(repoRoot, `stale-${workspaceName}.txt`, "rewrite\n");
  yield* runJj(repoRoot, ["new"]);
  yield* runJj(repoRoot, ["rebase", "-s", `${workspaceName}@`, "-d", "@-"]);
});

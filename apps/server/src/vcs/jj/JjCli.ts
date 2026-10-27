import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import {
  type VcsError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
  VcsWorkspaceStaleError,
} from "@t3tools/contracts";
import { isMissingExecutable } from "@t3tools/source-control-core/server/discovery";
import * as VcsProcess from "../VcsProcess.ts";

export const JJ_MIN_VERSION = "0.46.0";

export interface JjVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

export interface JjRunInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  // "observe" passes --ignore-working-copy; only foreground operations may snapshot.
  readonly workingCopy: "observe" | "snapshot";
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

// Every jj invocation goes through here so flags, config overrides, and error classification stay uniform.
export class JjCli extends Context.Service<
  JjCli,
  {
    readonly run: (input: JjRunInput) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    readonly version: Effect.Effect<JjVersion, VcsError>;
  }
>()("t3/vcs/jj/JjCli") {}

const CONFIG_OVERRIDES = [
  "ui.paginate=never",
  "ui.log-word-wrap=false",
  "snapshot.auto-update-stale=false",
  "git.abandon-unreachable-commits=false",
];

const JJ_ENV = { JJ_EDITOR: "false", JJ_PAGER: "cat", JJ_OP_USERNAME: "t3code" };

const VERSION_CACHE_TTL = Duration.minutes(1);
const ERROR_DETAIL_MAX_LENGTH = 500;

const STALE_PATTERN = /The working copy is stale|Could not read working copy's operation/;
const INDEX_LOCK_PATTERN = /Could not acquire lock for index file/;

export const parseJjVersion = (output: string): JjVersion | null => {
  const raw = output.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = /^jj\s+(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw };
};

export const isSupportedJjVersion = (version: JjVersion) => {
  const minimum = JJ_MIN_VERSION.split(".").map(Number);
  const installed = [version.major, version.minor, version.patch];
  for (const [index, part] of installed.entries()) {
    const difference = part - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

const jjArgs = (input: Pick<JjRunInput, "args" | "workingCopy">): ReadonlyArray<string> => [
  "--color=never",
  "--no-pager",
  ...CONFIG_OVERRIDES.flatMap((override) => ["--config", override]),
  ...(input.workingCopy === "observe" ? ["--ignore-working-copy"] : []),
  ...input.args,
];

const errorLine = (stderr: string, pattern?: RegExp) => {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim());
  const line =
    (pattern ? lines.find((candidate) => pattern.test(candidate)) : undefined) ??
    lines.find((candidate) => candidate.startsWith("Error:")) ??
    lines.find((candidate) => candidate.length > 0) ??
    "jj exited with a non-zero status.";
  return line.replace(/^Error:\s*/, "").slice(0, ERROR_DETAIL_MAX_LENGTH);
};

const missingJj = (operation: string) =>
  new VcsUnsupportedOperationError({
    operation,
    kind: "jj",
    detail: "Jujutsu (jj) is not installed or not on PATH.",
  });

export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const probeVersion = Effect.fn("JjCli.probeVersion")(function* () {
    const result = yield* vcsProcess
      .run({
        operation: "JjCli.version",
        command: "jj",
        args: ["--version"],
        cwd: process.cwd(),
        env: JJ_ENV,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
      })
      .pipe(Effect.catchIf(isMissingExecutable, () => Effect.fail(missingJj("JjCli.version"))));
    const version = parseJjVersion(result.stdout);
    if (version === null) {
      return yield* new VcsUnsupportedOperationError({
        operation: "JjCli.version",
        kind: "jj",
        detail: "Could not read the installed jj version.",
      });
    }
    return version;
  });

  // A missing or failing binary is re-probed on the next call so installs are picked up.
  const versionCache = yield* Cache.makeWith((_key: "version") => probeVersion(), {
    capacity: 1,
    timeToLive: Exit.match({
      onSuccess: () => VERSION_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  });
  const version = Cache.get(versionCache, "version");

  const requireSupportedVersion = Effect.fn("JjCli.requireSupportedVersion")(function* (
    operation: string,
  ) {
    const installed = yield* version;
    if (!isSupportedJjVersion(installed)) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: "jj",
        detail: `${installed.raw} is older than the supported minimum, jj ${JJ_MIN_VERSION}.`,
      });
    }
  });

  const runOnce = Effect.fn("JjCli.runOnce")(function* (input: JjRunInput) {
    const args = jjArgs(input);
    const result = yield* vcsProcess
      .run({
        operation: input.operation,
        command: "jj",
        args,
        cwd: input.cwd,
        env: JJ_ENV,
        allowNonZeroExit: true,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      })
      .pipe(Effect.catchIf(isMissingExecutable, () => Effect.fail(missingJj(input.operation))));

    if (result.exitCode === 0) return result;

    if (STALE_PATTERN.test(result.stderr)) {
      return yield* new VcsWorkspaceStaleError({
        operation: input.operation,
        cwd: input.cwd,
        detail: errorLine(result.stderr, STALE_PATTERN),
      });
    }

    const exitError = (detail: string, retryable: boolean) =>
      new VcsProcessExitError({
        operation: input.operation,
        command: "jj",
        cwd: input.cwd,
        argumentCount: args.length,
        exitCode: result.exitCode,
        detail,
        failureKind: "command-failed",
        ...(retryable ? { retryable: true } : {}),
        stderrLength: result.stderr.length,
        stderrTruncated: result.stderrTruncated,
      });

    if (INDEX_LOCK_PATTERN.test(result.stderr)) {
      return yield* exitError(VcsProcess.GIT_INDEX_LOCKED_DETAIL, true);
    }
    if (input.allowNonZeroExit) return result;
    return yield* exitError(errorLine(result.stderr), false);
  });

  const run = Effect.fn("JjCli.run")(function* (input: JjRunInput) {
    yield* requireSupportedVersion(input.operation);
    return yield* VcsProcess.retryTransientExit(runOnce(input));
  });

  return JjCli.of({ run, version });
});

export const layer = Layer.effect(JjCli, make);

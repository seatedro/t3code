import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { VcsError } from "@t3tools/contracts";
import type * as VcsProcess from "../VcsProcess.ts";

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

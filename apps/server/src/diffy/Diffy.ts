import * as NodeModule from "node:module";

import type { SemanticDiffFile, SemanticDiffGap, SemanticDiffRow } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Libdiffy from "libdiffy";

export class DiffyError extends Schema.TaggedError<DiffyError>()("DiffyError", {
  operation: Schema.Literals(["Diffy.load", "Diffy.diff", "Diffy.expand"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `${this.operation} failed.`;
  }
}

export type DiffyFileInput = Libdiffy.FileInput;

export class Diffy extends Context.Service<
  Diffy,
  {
    /** False when this platform has no Diffy binary. */
    readonly available: Effect.Effect<boolean>;
    /** None when this platform has no Diffy binary. Files come back in input order. */
    readonly diff: (
      files: ReadonlyArray<DiffyFileInput>,
      options: { readonly syntax: boolean },
    ) => Effect.Effect<Option.Option<ReadonlyArray<SemanticDiffFile>>, DiffyError>;
    readonly expand: (
      file: DiffyFileInput,
      gap: SemanticDiffGap,
      options: { readonly syntax: boolean },
    ) => Effect.Effect<Option.Option<ReadonlyArray<SemanticDiffRow>>, DiffyError>;
  }
>()("t3/diffy/Diffy") {}

// Covers the whole request, queueing included; files past it fall back to line diffs.
const REQUEST_BUDGET_MS = 5_000;

// libdiffy stays external: it loads a per-platform native binary from disk.
const requireForDiffy = NodeModule.createRequire(import.meta.url);

/** @public */
export const make = Effect.gen(function* () {
  const load = yield* Effect.cached(
    Effect.try({
      try: () => requireForDiffy("libdiffy") as typeof Libdiffy,
      catch: (cause) => new DiffyError({ operation: "Diffy.load", cause }),
    }).pipe(
      Effect.flatMap((module) =>
        module.FORMAT_VERSION === 1
          ? Effect.succeedSome(module)
          : Effect.logWarning("Diffy speaks an unsupported display format", {
              version: module.FORMAT_VERSION,
            }).pipe(Effect.as(Option.none<typeof Libdiffy>())),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Diffy is unavailable; diffs fall back to patches", { cause }).pipe(
          Effect.as(Option.none<typeof Libdiffy>()),
        ),
      ),
    ),
  );

  const diff: Diffy["Service"]["diff"] = Effect.fn("Diffy.diff")(function* (files, options) {
    const diffy = yield* load;
    if (Option.isNone(diffy)) return Option.none();
    const document = yield* Effect.tryPromise({
      try: (signal) =>
        diffy.value.diff(
          { files: [...files], budget_ms: REQUEST_BUDGET_MS, syntax: options.syntax },
          { signal },
        ),
      catch: (cause) => new DiffyError({ operation: "Diffy.diff", cause }),
    });
    return Option.some(document.files);
  });

  const expand: Diffy["Service"]["expand"] = Effect.fn("Diffy.expand")(
    function* (file, gap, options) {
      const diffy = yield* load;
      if (Option.isNone(diffy)) return Option.none();
      const rows = yield* Effect.tryPromise({
        try: () => diffy.value.expand(file, gap, { syntax: options.syntax }),
        catch: (cause) => new DiffyError({ operation: "Diffy.expand", cause }),
      });
      return Option.some(rows);
    },
  );

  return Diffy.of({ available: Effect.map(load, Option.isSome), diff, expand });
});

export const layer = Layer.effect(Diffy, make);

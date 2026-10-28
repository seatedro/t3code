import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./ForkMigrations/001_Memory.ts";

const migrationEntries = [[1, "Memory", Migration0001]] as const;

const run = Migrator.make({});

/**
 * Flock's own tables, migrated in a chain recorded apart from upstream's. Upstream's ids never
 * shift, so rebasing onto upstream never renumbers a migration either chain has applied.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
    table: "flock_migrations",
  });
  if (executed.length > 0)
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
});

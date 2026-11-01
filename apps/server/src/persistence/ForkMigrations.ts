import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./ForkMigrations/001_Memory.ts";
import Migration0002 from "./ForkMigrations/002_PushDevices.ts";

const migrationEntries = [
  [1, "Memory", Migration0001],
  [2, "PushDevices", Migration0002],
] as const;

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

export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flock_migrations'
  `;
  if (tables.length === 0) return true;
  const rows = yield* sql<{ readonly latestId: number | null }>`
    SELECT MAX(migration_id) AS latestId FROM flock_migrations
  `;
  return (rows[0]?.latestId ?? 0) < Math.max(...migrationEntries.map(([id]) => id));
});

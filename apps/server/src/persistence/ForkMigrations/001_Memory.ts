import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Memories are append-only and numbered from 0, so `id` is also the position.
  yield* sql`
    CREATE TABLE flock_memory_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      text TEXT NOT NULL
    )
  `;
  // One summary per aligned power-of-two block [lo, lo + size); each level fills in order.
  yield* sql`
    CREATE TABLE flock_memory_tree (
      size INTEGER NOT NULL,
      lo INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (size, lo)
    )
  `;
});

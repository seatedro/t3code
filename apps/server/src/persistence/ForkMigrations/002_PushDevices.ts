import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per Expo push token; registering again moves the token to the calling session.
  yield* sql`
    CREATE TABLE flock_push_devices (
      token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      notify_needs_you INTEGER NOT NULL,
      notify_finished INTEGER NOT NULL,
      notify_online INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_flock_push_devices_session ON flock_push_devices(session_id)`;
});

import type {
  AuthSessionId,
  PushDevicePreferences,
  PushDeviceRegisterInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class PushDeviceStorageError extends Schema.TaggedError<PushDeviceStorageError>()(
  "PushDeviceStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read or write this environment's push devices.";
  }
}

export class PushDevices extends Context.Service<
  PushDevices,
  {
    /** Stores the token for this session, taking it over from any other session. */
    readonly register: (
      sessionId: AuthSessionId,
      input: PushDeviceRegisterInput,
    ) => Effect.Effect<void, PushDeviceStorageError>;
    readonly unregister: (
      sessionId: AuthSessionId,
      token: string,
    ) => Effect.Effect<void, PushDeviceStorageError>;
    readonly hasAny: Effect.Effect<boolean, PushDeviceStorageError>;
    /**
     * Tokens that want this kind of push. Tokens of revoked or expired sessions are deleted first,
     * whichever process revoked them.
     */
    readonly tokensWanting: (
      preference: keyof PushDevicePreferences,
    ) => Effect.Effect<ReadonlyArray<string>, PushDeviceStorageError>;
    readonly forget: (tokens: ReadonlyArray<string>) => Effect.Effect<void, PushDeviceStorageError>;
    readonly forgetSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, PushDeviceStorageError>;
  }
>()("t3/push/PushDevices") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new PushDeviceStorageError({ cause })));
  const flag = (value: boolean) => (value ? 1 : 0);

  return PushDevices.of({
    register: Effect.fn("PushDevices.register")(function* (sessionId, { token, preferences }) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* stored(sql`
        INSERT INTO flock_push_devices (
          token, session_id, notify_needs_you, notify_finished, notify_online, updated_at
        )
        VALUES (
          ${token},
          ${sessionId},
          ${flag(preferences.needsYou)},
          ${flag(preferences.finished)},
          ${flag(preferences.online)},
          ${now}
        )
        ON CONFLICT (token) DO UPDATE SET
          session_id = excluded.session_id,
          notify_needs_you = excluded.notify_needs_you,
          notify_finished = excluded.notify_finished,
          notify_online = excluded.notify_online,
          updated_at = excluded.updated_at
      `);
    }),
    unregister: Effect.fn("PushDevices.unregister")(function* (sessionId, token) {
      yield* stored(
        sql`DELETE FROM flock_push_devices WHERE token = ${token} AND session_id = ${sessionId}`,
      );
    }),
    hasAny: stored(sql`SELECT 1 FROM flock_push_devices LIMIT 1`).pipe(
      Effect.map((rows) => rows.length > 0),
    ),
    tokensWanting: Effect.fn("PushDevices.tokensWanting")(function* (preference) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const wants = {
        needsYou: sql`devices.notify_needs_you = 1`,
        finished: sql`devices.notify_finished = 1`,
        online: sql`devices.notify_online = 1`,
      }[preference];
      yield* stored(sql`
        DELETE FROM flock_push_devices
        WHERE session_id NOT IN (
          SELECT session_id FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ${now}
        )
      `);
      const rows = yield* stored(sql<{ readonly token: string }>`
        SELECT devices.token AS "token"
        FROM flock_push_devices devices
        WHERE ${wants}
        ORDER BY devices.token
      `);
      return rows.map((row) => row.token);
    }),
    forget: Effect.fn("PushDevices.forget")(function* (tokens) {
      if (tokens.length === 0) return;
      yield* stored(sql`DELETE FROM flock_push_devices WHERE ${sql.in("token", tokens)}`);
    }),
    forgetSession: Effect.fn("PushDevices.forgetSession")(function* (sessionId) {
      yield* stored(sql`DELETE FROM flock_push_devices WHERE session_id = ${sessionId}`);
    }),
  });
});

export const layer = Layer.effect(PushDevices, make);

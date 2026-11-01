import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PushDevices from "./PushDevices.ts";

const devicesLayer = PushDevices.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
);

const PHONE = "ExponentPushToken[phone]";
const TABLET = "ExponentPushToken[tablet]";
const ALL = { needsYou: true, finished: true, online: true };

const insertSession = Effect.fnUntraced(function* (
  sessionId: AuthSessionId,
  options: { readonly expiresAt?: string; readonly revokedAt?: string } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
    VALUES (
      ${sessionId},
      'test',
      '[]',
      'browser-session-cookie',
      '1970-01-01T00:00:00.000Z',
      ${options.expiresAt ?? "2099-01-01T00:00:00.000Z"},
      ${options.revokedAt ?? null}
    )
  `;
});

it.layer(devicesLayer)("PushDevices", (it) => {
  it.effect("keeps each token with the session that registered it last", () =>
    Effect.gen(function* () {
      const devices = yield* PushDevices.PushDevices;
      const first = AuthSessionId.make("session-first");
      const second = AuthSessionId.make("session-second");
      yield* insertSession(first);
      yield* insertSession(second);

      yield* devices.register(first, { token: PHONE, preferences: ALL });
      yield* devices.register(second, { token: PHONE, preferences: ALL });
      // The session that lost the token cannot remove it from the one that holds it.
      yield* devices.unregister(first, PHONE);
      assert.deepStrictEqual(yield* devices.tokensWanting("needsYou"), [PHONE]);

      yield* devices.unregister(second, PHONE);
      assert.deepStrictEqual(yield* devices.tokensWanting("needsYou"), []);
      assert.isFalse(yield* devices.hasAny);
    }),
  );

  it.effect("sends only what a device asked for, and forgets tokens of ended sessions", () =>
    Effect.gen(function* () {
      const devices = yield* PushDevices.PushDevices;
      const live = AuthSessionId.make("session-live");
      const revoked = AuthSessionId.make("session-revoked");
      const expired = AuthSessionId.make("session-expired");
      yield* insertSession(live);
      yield* insertSession(revoked, { revokedAt: "1970-01-01T00:00:00.000Z" });
      yield* insertSession(expired, { expiresAt: "1969-12-31T00:00:00.000Z" });

      yield* devices.register(live, {
        token: PHONE,
        preferences: { needsYou: true, finished: false, online: true },
      });
      yield* devices.register(live, {
        token: TABLET,
        preferences: { needsYou: false, finished: true, online: false },
      });
      yield* devices.register(revoked, { token: "ExponentPushToken[revoked]", preferences: ALL });
      yield* devices.register(expired, { token: "ExpoPushToken[expired]", preferences: ALL });

      assert.deepStrictEqual(yield* devices.tokensWanting("needsYou"), [PHONE]);
      assert.deepStrictEqual(yield* devices.tokensWanting("finished"), [TABLET]);
      assert.deepStrictEqual(yield* devices.tokensWanting("online"), [PHONE]);

      // A session revoked by another process, such as `t3 auth session revoke`, is caught here.
      yield* devices.forgetSession(live);
      assert.isFalse(yield* devices.hasAny);
    }),
  );
});

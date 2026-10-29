import type { TailscaleNode } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import { TailscaleLocal } from "../tailnet/TailscaleLocal.ts";

/** Sessions admitted by Tailscale identity: the node's stable id and whose device it was let in as. */
export const TAILNET_DEVICE_SUBJECT_PREFIX = "tailnet-device:";

export const isTailnetDeviceSubject = (subject: string): boolean =>
  subject.startsWith(TAILNET_DEVICE_SUBJECT_PREFIX);

/**
 * Whose devices trust admits: this machine's own Tailscale user, by id and login, or the
 * configured login when the machine is tagged. Null when nobody qualifies.
 */
export const trustedIdentityOf = (self: TailscaleNode, configuredLogin: string): string | null => {
  if (self.tagged) {
    const login = configuredLogin.trim().toLowerCase();
    return login === "" ? null : `login:${login}`;
  }
  return self.userId === null || self.loginName === null
    ? null
    : `user:${self.userId}:${self.loginName}`;
};

/** The subject is signed into the token, so the stamp cannot be changed by the client. */
export const tailnetDeviceSubject = (stableId: string, trustedIdentity: string): string =>
  `${TAILNET_DEVICE_SUBJECT_PREFIX}${encodeURIComponent(stableId)}:${encodeURIComponent(trustedIdentity)}`;

/** The identity a `tailnet-device:` session was admitted under. */
export const admittedIdentityOf = (subject: string): string | null => {
  const parts = subject.slice(TAILNET_DEVICE_SUBJECT_PREFIX.length).split(":");
  return parts.length === 2 && parts[1] !== undefined ? decodeURIComponent(parts[1]) : null;
};

/**
 * `mismatch`: admitted under an identity trust no longer covers (another login, or this
 * machine signed in to Tailscale as someone else). `unknown`: Tailscale has not said yet.
 */
export type TailnetSessionVerdict = "admitted" | "off" | "unknown" | "mismatch";

/**
 * Whether sessions admitted by Tailscale identity may still authenticate. Refuses all of them
 * unless the server provides it, so a layer that forgets it locks them out rather than in.
 */
export class TailnetSessionGate extends Context.Reference<{
  readonly check: (subject: string) => Effect.Effect<TailnetSessionVerdict>;
  /** Completes once the subject stops being admitted, for connections that outlive a check. */
  readonly whenRefused: (subject: string) => Effect.Effect<void>;
}>("t3/auth/TailnetSessionGate", {
  defaultValue: () => ({
    check: () => Effect.succeed("off"),
    whenRefused: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  TailnetSessionGate,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const tailscale = yield* TailscaleLocal;
    // A tailscaled restart must not sign devices out, so the identity last seen stands in.
    const lastSelf = yield* Ref.make<TailscaleNode | null>(null);
    const currentSelf = tailscale.tailnet.pipe(
      Effect.flatMap((tailnet) =>
        tailnet?.self
          ? Ref.set(lastSelf, tailnet.self).pipe(Effect.as(tailnet.self))
          : Ref.get(lastSelf),
      ),
    );

    const check = Effect.fn("TailnetSessionGate.check")(function* (subject: string) {
      const current = yield* settings.getSettings.pipe(Effect.option);
      if (Option.isNone(current) || !current.value.tailnetTrustEnabled) {
        return "off" satisfies TailnetSessionVerdict;
      }
      const self = yield* currentSelf;
      if (self === null) return "unknown" satisfies TailnetSessionVerdict;
      const trusted = trustedIdentityOf(self, current.value.tailnetTrustLogin);
      return trusted !== null && admittedIdentityOf(subject) === trusted
        ? ("admitted" satisfies TailnetSessionVerdict)
        : ("mismatch" satisfies TailnetSessionVerdict);
    });

    // Not knowing yet is no reason to drop a connection that was let in.
    const refused = (verdict: TailnetSessionVerdict) => verdict === "off" || verdict === "mismatch";
    const whenRefused = (subject: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* settings.subscribeChanges;
          if (refused(yield* check(subject))) return;
          yield* changes.pipe(
            Stream.mapEffect(() => check(subject)),
            Stream.filter(refused),
            Stream.runHead,
          );
        }),
      );

    return { check, whenRefused };
  }),
);

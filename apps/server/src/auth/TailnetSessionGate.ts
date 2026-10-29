import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";

/** Sessions admitted by Tailscale identity carry the node's stable id after this prefix. */
export const TAILNET_DEVICE_SUBJECT_PREFIX = "tailnet-device:";

export const isTailnetDeviceSubject = (subject: string): boolean =>
  subject.startsWith(TAILNET_DEVICE_SUBJECT_PREFIX);

/**
 * Whether sessions admitted by Tailscale identity may authenticate right now. Closed unless the
 * server provides the setting, so a layer that forgets it refuses them rather than lets them in.
 */
export class TailnetSessionGate extends Context.Reference<{
  readonly isOpen: Effect.Effect<boolean>;
}>("t3/auth/TailnetSessionGate", { defaultValue: () => ({ isOpen: Effect.succeed(false) }) }) {}

/** Reads the setting on every check: a session must stop working the moment trust is off. */
export const layerFromSettings = Layer.effect(
  TailnetSessionGate,
  Effect.map(ServerSettingsService, (settings) => ({
    isOpen: settings.getSettings.pipe(
      Effect.map((current) => current.tailnetTrustEnabled),
      Effect.orElseSucceed(() => false),
    ),
  })),
);

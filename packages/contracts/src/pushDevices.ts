import * as Schema from "effect/Schema";

/** A token from Expo's `getExpoPushTokenAsync`; the server only sends through Expo's push service. */
export const ExpoPushToken = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^Expo(nent)?PushToken\[[^\]]+\]$/),
);
export type ExpoPushToken = typeof ExpoPushToken.Type;

/** Which pushes a registered device wants from this environment. */
export const PushDevicePreferences = Schema.Struct({
  /** A thread waits for an approval or an answer. */
  needsYou: Schema.Boolean,
  /** A thread finished or failed. */
  finished: Schema.Boolean,
  /** A silent push when this server starts, so the app can tell a waiting user it's back. */
  online: Schema.Boolean,
});
export type PushDevicePreferences = typeof PushDevicePreferences.Type;

export const PushDeviceRegisterInput = Schema.Struct({
  token: ExpoPushToken,
  preferences: PushDevicePreferences,
});
export type PushDeviceRegisterInput = typeof PushDeviceRegisterInput.Type;

export const PushDeviceUnregisterInput = Schema.Struct({ token: ExpoPushToken });
export type PushDeviceUnregisterInput = typeof PushDeviceUnregisterInput.Type;

export class PushDeviceError extends Schema.TaggedError<PushDeviceError>()("PushDeviceError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The `data` of every push this server sends; Expo hands it to the app as
 * `notification.request.content.data`, the same keys the T3 relay's pushes carry.
 */
export type PushNotificationData =
  | {
      readonly kind: "needs-you" | "finished";
      readonly environmentId: string;
      readonly threadId: string;
      readonly deepLink: string;
    }
  | { readonly kind: "environment-online"; readonly environmentId: string };

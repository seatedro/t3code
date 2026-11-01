import { UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  // "limits" was a metric tab before limits moved onto every view; it reads as tokens.
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
  hiddenProviders: Schema.optional(Schema.Array(UsageProviderKind)),
});
type StoredUsagePagePreferences = typeof UsagePagePreferencesSchema.Type;
export type UsagePagePreferences = Omit<StoredUsagePagePreferences, "metric"> & {
  readonly metric: "cost" | "tokens";
};

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "tokens", windowDays: 30 };

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const stored = getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema);
    if (stored === null) return DEFAULT_PREFERENCES;
    return { ...stored, metric: stored.metric === "cost" ? "cost" : "tokens" };
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}

import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { UsageMetric } from "@t3tools/client-runtime/usage-ledger";
import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

export const METRIC_OPTIONS = [
  { value: "tokens", label: "Tokens", command: "usage.tokens" },
  { value: "cost", label: "Cost", command: "usage.cost" },
] as const satisfies readonly { value: UsageMetric; label: string; command: KeybindingCommand }[];

/** Limits are always on the page; the shortcut opens every limit in detail. */
export const ALL_LIMITS_COMMAND = "usage.limits" satisfies KeybindingCommand;

export const WINDOW_OPTIONS = [
  { days: 1, label: "24h", title: "Past 24 hours", span: "24 hours", command: "usage.period.day" },
  { days: 7, label: "7d", title: "Past 7 days", span: "7 days", command: "usage.period.week" },
  { days: 30, label: "30d", title: "Past 30 days", span: "30 days", command: "usage.period.month" },
  {
    days: 90,
    label: "90d",
    title: "Past 90 days",
    span: "90 days",
    command: "usage.period.quarter",
  },
] as const;

export function resolveUsageShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
) {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest(
        '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal])',
      ))
  ) {
    return null;
  }

  return resolveShortcutCommand(event, keybindings, {
    context: { usagePageOpen: true },
  });
}

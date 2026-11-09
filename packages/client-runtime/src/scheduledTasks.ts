import type { ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const ONCE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "once")
    return `Once, ${ONCE_FORMATTER.format(DateTime.toEpochMillis(DateTime.makeUnsafe(schedule.runAt)))}`;
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    if (!Number.isInteger(minutes)) return `Every ${Math.round(schedule.everyMs / 1000)} sec`;
    if (minutes % 60 !== 0) return `Every ${minutes} min`;
    return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

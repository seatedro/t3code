// @effect-diagnostics globalDate:off -- Usage windows and limit clocks are wall-clock values supplied by the caller.
import {
  UsageDay,
  type ServerProviderUsageWindow,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { enumerateDays, enumerateHourStarts } from "@t3tools/shared/usageFormat";
import {
  cursorUsageWindowDetails,
  displayLimitWindows,
  elapsedShare,
  spentWeeklyWindow,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import {
  isModelCostUnknown,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
  type ModelTotals,
} from "@t3tools/shared/usageMerge";

export type UsageMetric = "tokens" | "cost";

/**
 * Categorical order the palette was validated in on dark surfaces (adjacent pairs pass CVD and
 * normal-vision separation; Pi beside Antigravity sits in the 6-8 band, so charts keep gaps and a
 * legend). A ninth provider folds into an existing hue rather than a generated one.
 */
export const USAGE_PROVIDER_ORDER = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "pi",
  "muse",
] as const satisfies readonly UsageProviderKind[];

export const USAGE_PROVIDER_COLORS: Record<UsageProviderKind, string> = {
  claude: "#D5704F",
  codex: "#4E8FE8",
  cursor: "#3FA86B",
  grok: "#9C7FE0",
  opencode: "#A88A2E",
  antigravity: "#C766A0",
  pi: "#3AA0C8",
  muse: "#8C9A2E",
};

const PROVIDER_DRIVERS: Record<UsageProviderKind, string> = {
  claude: "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
  muse: "muse",
};

export function usageProviderOfDriver(driver: string): UsageProviderKind | null {
  return USAGE_PROVIDER_ORDER.find((provider) => PROVIDER_DRIVERS[provider] === driver) ?? null;
}

/** The day or hour starts a window covers, oldest first. */
export function usagePeriods(window: UsageSummaryInput): readonly string[] {
  if (window.resolution === "hour") {
    return window.sinceTime === undefined || window.untilTime === undefined
      ? []
      : enumerateHourStarts(window.sinceTime, window.untilTime);
  }
  return enumerateDays(window.sinceDay, window.untilDay);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDay(day: string, days: number): UsageDay {
  return UsageDay.make(
    new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10),
  );
}

function dayIn(instantMs: number, timeZone: string): UsageDay {
  return UsageDay.make(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instantMs),
  );
}

/**
 * The equally long window that ends where this one starts. A day window's last day is usually
 * still in progress, so the comparison is against complete days; the server reports both from the
 * same transcripts.
 */
export function previousUsageWindow(window: UsageSummaryInput): UsageSummaryInput {
  if (
    window.resolution === "hour" &&
    window.sinceTime !== undefined &&
    window.untilTime !== undefined
  ) {
    const untilMs = Date.parse(window.sinceTime);
    const sinceMs = untilMs - (Date.parse(window.untilTime) - untilMs);
    return {
      sinceDay: dayIn(sinceMs, window.timeZone),
      untilDay: dayIn(untilMs, window.timeZone),
      timeZone: window.timeZone,
      resolution: "hour",
      sinceTime: new Date(sinceMs).toISOString(),
      untilTime: new Date(untilMs).toISOString(),
    };
  }
  const length =
    Math.round(
      (Date.parse(`${window.untilDay}T00:00:00Z`) - Date.parse(`${window.sinceDay}T00:00:00Z`)) /
        DAY_MS,
    ) + 1;
  return {
    sinceDay: shiftDay(window.sinceDay, -length),
    untilDay: shiftDay(window.sinceDay, -1),
    timeZone: window.timeZone,
    resolution: window.resolution ?? "day",
  };
}

/** Fractional change (0.18 is up 18%), or null when there is nothing to compare against. */
export function usageChange(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

export function usageValue(
  totals: { readonly costUsd: number; readonly totalTokens: number } | undefined,
  metric: UsageMetric,
): number {
  if (totals === undefined) return 0;
  return metric === "tokens" ? totals.totalTokens : totals.costUsd;
}

function periodTotals(merged: MergedUsage, window: UsageSummaryInput) {
  const totals: readonly (DailyTotals | HourlyTotals)[] =
    window.resolution === "hour" ? merged.hourly : merged.daily;
  return new Map(
    totals.map((entry) => ["hourStart" in entry ? entry.hourStart : entry.day, entry] as const),
  );
}

export interface UsagePeriodColumn {
  readonly period: string;
  readonly total: number;
  /** One band per requested provider, in the requested order. */
  readonly bands: readonly { readonly provider: UsageProviderKind; readonly value: number }[];
}

export function usageColumns(
  merged: MergedUsage,
  window: UsageSummaryInput,
  metric: UsageMetric,
  providers: readonly UsageProviderKind[],
): readonly UsagePeriodColumn[] {
  const byPeriod = periodTotals(merged, window);
  return usagePeriods(window).map((period) => {
    const entry = byPeriod.get(period);
    const bands = providers.map((provider) => ({
      provider,
      value: usageValue(entry?.byProvider.get(provider), metric),
    }));
    return { period, bands, total: bands.reduce((sum, band) => sum + band.value, 0) };
  });
}

/** Providers with activity, largest first, so the biggest series sits at the base of a stack. */
export function rankUsageProviders(
  merged: MergedUsage,
  metric: UsageMetric,
): readonly {
  readonly provider: UsageProviderKind;
  readonly value: number;
  readonly share: number;
  readonly sessions: number;
}[] {
  return merged.providers
    .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
    .map((entry) => ({
      provider: entry.provider,
      value: usageValue(entry, metric),
      share: metric === "tokens" ? entry.tokenShare : entry.costShare,
      sessions: entry.sessions,
    }))
    .sort(
      (left, right) =>
        right.value - left.value ||
        USAGE_PROVIDER_ORDER.indexOf(left.provider) - USAGE_PROVIDER_ORDER.indexOf(right.provider),
    );
}

/** The busiest period and the mean across every period in the window, idle ones included. */
export function usagePeakAndAverage(
  merged: MergedUsage,
  window: UsageSummaryInput,
  metric: UsageMetric,
): {
  readonly peak: { readonly period: string; readonly value: number } | null;
  readonly average: number;
} {
  const periods = usagePeriods(window);
  const byPeriod = periodTotals(merged, window);
  let peak: { period: string; value: number } | null = null;
  let total = 0;
  for (const period of periods) {
    const value = usageValue(byPeriod.get(period), metric);
    total += value;
    if (value > 0 && (peak === null || value > peak.value)) peak = { period, value };
  }
  return { peak, average: periods.length === 0 ? 0 : total / periods.length };
}

export interface RankedUsageModel {
  readonly model: ModelTotals;
  /** Null when the metric is cost and no record had a price. */
  readonly value: number | null;
  /** One point per period; an unpriced model trends by tokens. */
  readonly trend: readonly number[];
}

export function rankUsageModels(
  merged: MergedUsage,
  window: UsageSummaryInput,
  metric: UsageMetric,
): readonly RankedUsageModel[] {
  const periods = usagePeriods(window);
  return merged.models
    .map((model) => {
      const unknown = metric === "cost" && isModelCostUnknown(model);
      const trendMetric = unknown ? "tokens" : metric;
      return {
        model,
        value: unknown ? null : usageValue(model, metric),
        trend: periods.map((period) => usageValue(model.byPeriod.get(period), trendMetric)),
      };
    })
    .sort(
      (left, right) =>
        (right.value ?? -1) - (left.value ?? -1) ||
        right.model.totalTokens - left.model.totalTokens,
    );
}

export interface UsageEfficiency {
  /** Cached input over all input; cache writes count as misses. */
  readonly cacheHitShare: number | null;
  readonly cacheSavingsUsd: number;
  readonly outputShare: number | null;
  readonly speedPremiumUsd: number;
  readonly speedPremiumProviders: readonly UsageProviderKind[];
}

export function usageEfficiency(merged: MergedUsage): UsageEfficiency {
  const input = merged.uncachedInputTokens + merged.cachedInputTokens + merged.cacheCreationTokens;
  return {
    cacheHitShare: input === 0 ? null : merged.cachedInputTokens / input,
    cacheSavingsUsd: merged.costQuality.cacheSavingsUsd,
    outputShare: merged.totalTokens === 0 ? null : merged.outputTokens / merged.totalTokens,
    speedPremiumUsd: merged.speedCost.premium,
    speedPremiumProviders: merged.providers
      .filter((entry) => entry.speedPremiumUsd > 0)
      .map((entry) => entry.provider),
  };
}

/** At or below this share left a limit reads as low. */
export const LIMIT_LOW_PERCENT = 15;

export type LimitSeverity = "ok" | "low" | "out";

export function limitSeverity(remainingPercent: number): LimitSeverity {
  if (remainingPercent <= 0) return "out";
  return remainingPercent <= LIMIT_LOW_PERCENT ? "low" : "ok";
}

/** A session window held at 100% by every member's spent weekly limit, not by session spending. */
export function isBlockedSession(window: LimitPoolWindow): boolean {
  return (
    window.kind === "session" &&
    window.members.length > 0 &&
    window.members.every((member) => spentWeeklyWindow(member.account) !== undefined)
  );
}

export function limitWindowLabel(pool: LimitPool, window: LimitPoolWindow): string {
  return (
    (pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool)?.label : undefined) ??
    window.label
  );
}

/** The word a compact limit chip shows after its percentage. */
export function limitWindowNoun(pool: LimitPool, window: LimitPoolWindow): string {
  const label = limitWindowLabel(pool, window);
  if (label === "Session") return "session";
  if (label === "Weekly") return "week";
  if (label === "Monthly") return "month";
  return label.toLowerCase();
}

function resetAt(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

// Projections from the first minutes of a window swing wildly, so wait for a twentieth of it.
const MIN_PROJECTION_ELAPSED = 0.05;

/** When spending at the window's average rate so far would exhaust it, if that lands before reset. */
export function windowRunOutAt(window: ServerProviderUsageWindow, now: number): number | null {
  const elapsed = elapsedShare(window, now);
  const resets = resetAt(window);
  if (
    elapsed === null ||
    resets === null ||
    window.windowDurationMins === undefined ||
    elapsed < MIN_PROJECTION_ELAPSED ||
    window.usedPercent <= 0 ||
    window.usedPercent >= 100
  ) {
    return null;
  }
  const elapsedMs = elapsed * window.windowDurationMins * 60_000;
  const at = now + ((100 - window.usedPercent) * elapsedMs) / window.usedPercent;
  return at < resets ? at : null;
}

/** A pooled window runs out when its last member does, unless a spent member refills first. */
export function poolRunOutAt(window: LimitPoolWindow, now: number): number | null {
  const spending = window.members.filter((member) => member.window.usedPercent < 100);
  if (spending.length === 0) return null;
  let at = 0;
  for (const member of spending) {
    const memberAt = windowRunOutAt(member.window, now);
    if (memberAt === null) return null;
    at = Math.max(at, memberAt);
  }
  const refillsFirst = window.members.some((member) => {
    if (member.window.usedPercent < 100) return false;
    const refill = resetAt(member.window);
    return refill !== null && refill <= at;
  });
  return refillsFirst ? null : at;
}

export interface LimitHeadline {
  readonly pool: LimitPool;
  /** Display order. */
  readonly windows: readonly LimitPoolWindow[];
  /** The tightest window: what decides whether the provider can keep working. */
  readonly binding: LimitPoolWindow;
  readonly severity: LimitSeverity;
  /** When a spent provider gets quota back. */
  readonly backAt: number | null;
  readonly runOut: { readonly window: LimitPoolWindow; readonly at: number } | null;
}

export function limitHeadline(pool: LimitPool, now: number): LimitHeadline | null {
  const windows = displayLimitWindows(pool);
  if (windows.length === 0) return null;
  // A blocked session repeats its weekly cause, so the weekly window wins a tie at 0%.
  const binding = windows.reduce((tightest, window) =>
    window.remainingPercent < tightest.remainingPercent ||
    (window.remainingPercent === tightest.remainingPercent &&
      isBlockedSession(tightest) &&
      !isBlockedSession(window))
      ? window
      : tightest,
  );
  const severity = limitSeverity(binding.remainingPercent);
  let runOut: LimitHeadline["runOut"] = null;
  if (severity !== "out") {
    for (const window of windows) {
      const at = poolRunOutAt(window, now);
      if (at !== null && (runOut === null || at < runOut.at)) runOut = { window, at };
    }
  }
  return {
    pool,
    windows,
    binding,
    severity,
    backAt:
      severity === "out"
        ? (binding.resets.find((reset) => reset.restoresPercent > 0)?.at ??
          binding.resets[0]?.at ??
          null)
        : null,
    runOut,
  };
}

/** One headline per provider with limits, in palette order so chips keep their places. */
export function limitHeadlines(pools: readonly LimitPool[], now: number): readonly LimitHeadline[] {
  const rank = (pool: LimitPool) => {
    const provider = usageProviderOfDriver(pool.driver);
    return provider === null ? USAGE_PROVIDER_ORDER.length : USAGE_PROVIDER_ORDER.indexOf(provider);
  };
  return [...pools]
    .sort((left, right) => rank(left) - rank(right))
    .flatMap((pool) => {
      const headline = limitHeadline(pool, now);
      return headline === null ? [] : [headline];
    });
}

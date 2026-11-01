// @effect-diagnostics globalDate:off -- Fixtures pin limit clocks to fixed instants.
import {
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type ServerProviderUsageWindow,
  type UsageBucket,
  type UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  limitHeadline,
  limitSeverity,
  previousUsageWindow,
  rankUsageModels,
  usageChange,
  usageColumns,
  usageEfficiency,
  windowRunOutAt,
} from "./usageLedger.ts";

const NOW = Date.parse("2026-10-31T14:28:00.000Z");
const MINUTE = 60_000;

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-10-30" as UsageDay,
    provider: "claude",
    model: "claude-opus-5-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 800,
      cacheCreationTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function merged(buckets: readonly UsageBucket[]) {
  return mergeUsage(
    [
      {
        environmentId: "env" as EnvironmentId,
        label: "env",
        summary: {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-10-31T14:28:00.000Z",
          timeZone: "UTC",
          sinceDay: "2026-10-29" as UsageDay,
          untilDay: "2026-10-31" as UsageDay,
          buckets,
          sources: (["claude", "codex"] as const).map((provider) => ({
            fingerprint: {
              hostId: "mac",
              provider,
              resolvedHomePath: `/home/${provider}`,
              volumeId: "vol",
            },
            status: "ok" as const,
            scannedFiles: 1,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 1,
            message: null,
          })),
          pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
          scanDurationMs: 1,
        },
      },
    ],
    USAGE_CONTRACT_VERSION,
  );
}

const THREE_DAYS: UsageSummaryInput = {
  sinceDay: "2026-10-29" as UsageDay,
  untilDay: "2026-10-31" as UsageDay,
  timeZone: "UTC",
  resolution: "day",
};

describe("previousUsageWindow", () => {
  it("compares a day window with the equally long run of days before it", () => {
    expect(
      previousUsageWindow({
        sinceDay: "2026-10-02" as UsageDay,
        untilDay: "2026-10-31" as UsageDay,
        timeZone: "America/New_York",
        resolution: "day",
      }),
    ).toEqual({
      sinceDay: "2026-09-02",
      untilDay: "2026-10-01",
      timeZone: "America/New_York",
      resolution: "day",
    });
  });

  it("compares the past 24 hours with the 24 before them, naming days in the window's zone", () => {
    expect(
      previousUsageWindow({
        sinceDay: "2026-10-30" as UsageDay,
        untilDay: "2026-10-31" as UsageDay,
        timeZone: "America/Los_Angeles",
        resolution: "hour",
        sinceTime: "2026-10-30T21:28:00.000Z",
        untilTime: "2026-10-31T21:28:00.000Z",
      }),
    ).toEqual({
      sinceDay: "2026-10-29",
      untilDay: "2026-10-30",
      timeZone: "America/Los_Angeles",
      resolution: "hour",
      sinceTime: "2026-10-29T21:28:00.000Z",
      untilTime: "2026-10-30T21:28:00.000Z",
    });
  });
});

describe("usageChange", () => {
  it("reports the fractional change, and nothing when the earlier period was empty", () => {
    expect(usageChange(118, 100)).toBeCloseTo(0.18);
    expect(usageChange(80, 100)).toBeCloseTo(-0.2);
    expect(usageChange(50, 0)).toBeNull();
  });
});

describe("usageColumns", () => {
  it("keeps each provider's band absolute, in the requested order, with idle days at zero", () => {
    const usage = merged([
      bucket({ day: "2026-10-29" as UsageDay }),
      bucket({
        day: "2026-10-29" as UsageDay,
        provider: "codex",
        model: "gpt-6-astra",
        costUsd: 4,
      }),
    ]);
    expect(usageColumns(usage, THREE_DAYS, "cost", ["codex", "claude", "grok"])).toEqual([
      {
        period: "2026-10-29",
        total: 14,
        bands: [
          { provider: "codex", value: 4 },
          { provider: "claude", value: 10 },
          { provider: "grok", value: 0 },
        ],
      },
      {
        period: "2026-10-30",
        total: 0,
        bands: [
          { provider: "codex", value: 0 },
          { provider: "claude", value: 0 },
          { provider: "grok", value: 0 },
        ],
      },
      {
        period: "2026-10-31",
        total: 0,
        bands: [
          { provider: "codex", value: 0 },
          { provider: "claude", value: 0 },
          { provider: "grok", value: 0 },
        ],
      },
    ]);
  });
});

describe("rankUsageModels", () => {
  it("fills idle periods with zero and ranks a model with no price last by cost", () => {
    const usage = merged([
      bucket({ day: "2026-10-29" as UsageDay }),
      bucket({ day: "2026-10-31" as UsageDay, costUsd: 30 }),
      bucket({
        provider: "codex",
        model: "gpt-6-astra",
        day: "2026-10-30" as UsageDay,
        costUsd: 0,
        costSource: "unpriced",
        unpricedRecords: 5,
      }),
    ]);

    const byCost = rankUsageModels(usage, THREE_DAYS, "cost");
    expect(byCost.map(({ model, value, trend }) => [model.model, value, trend])).toEqual([
      ["claude-opus-5-5", 40, [10, 0, 30]],
      ["gpt-6-astra", null, [0, 1050, 0]],
    ]);
    expect(rankUsageModels(usage, THREE_DAYS, "tokens")[0]?.trend).toEqual([1050, 0, 1050]);
  });
});

describe("usageEfficiency", () => {
  it("counts cache writes as misses and names the providers that paid a speed premium", () => {
    const efficiency = usageEfficiency(
      merged([bucket(), bucket({ provider: "codex", model: "gpt-6-astra", speedPremiumUsd: 4 })]),
    );
    expect(efficiency.cacheHitShare).toBeCloseTo(0.8);
    expect(efficiency.outputShare).toBeCloseTo(50 / 1050);
    expect(efficiency.cacheSavingsUsd).toBe(4);
    expect(efficiency.speedPremiumUsd).toBe(4);
    expect(efficiency.speedPremiumProviders).toEqual(["codex"]);
  });
});

describe("limitSeverity", () => {
  it("is low at 15% left and out at none", () => {
    expect([16, 15, 1, 0].map(limitSeverity)).toEqual(["ok", "low", "low", "out"]);
  });
});

function window(
  overrides: Partial<ServerProviderUsageWindow> & Pick<ServerProviderUsageWindow, "id">,
): ServerProviderUsageWindow {
  return {
    kind: "session",
    label: "Session",
    usedPercent: 0,
    windowDurationMins: 300,
    resetsAt: new Date(NOW + 60 * MINUTE).toISOString(),
    ...overrides,
  };
}

function account(
  key: string,
  driver: string,
  windows: readonly ServerProviderUsageWindow[],
): LimitAccount {
  return {
    key,
    driver: ProviderDriverKind.make(driver),
    displayName: null,
    email: `${key}@example.com`,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: new Date(NOW).toISOString(), windows },
  };
}

function headline(accounts: readonly LimitAccount[]) {
  const pool = collectLimitPools(accounts, NOW)[0]!;
  return limitHeadline(pool, NOW)!;
}

describe("limitHeadline", () => {
  it("headlines the tightest window and projects when it runs out at this pace", () => {
    const claude = headline([
      account("claude", "claudeAgent", [
        // 228 of 300 minutes gone and 91% spent: the last 9% lasts 9 * 228 / 91 minutes.
        window({ id: "five_hour", usedPercent: 91, resetsAt: iso(72) }),
        window({
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 41,
          windowDurationMins: 7 * 24 * 60,
          resetsAt: iso(43 * 60),
        }),
      ]),
    ]);
    expect(claude.binding.id).toBe("five_hour");
    expect(claude.severity).toBe("low");
    expect(claude.backAt).toBeNull();
    expect(claude.runOut?.window.id).toBe("five_hour");
    expect((claude.runOut!.at - NOW) / MINUTE).toBeCloseTo((9 * 228) / 91);
  });

  it("headlines a spent weekly over the session it blocks, and says when quota returns", () => {
    const weekly = (resetIn: number) =>
      window({
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: iso(resetIn),
      });
    const codex = headline([
      account("work", "codex", [
        window({ id: "primary", usedPercent: 34, resetsAt: iso(185) }),
        weekly(64 * 60),
      ]),
      account("personal", "codex", [
        window({ id: "primary", usedPercent: 20, resetsAt: iso(200) }),
        weekly(70 * 60),
      ]),
    ]);
    expect(codex.binding.kind).toBe("weekly");
    expect(codex.windows.map((window) => window.kind)).toEqual(["weekly", "session"]);
    expect(codex.severity).toBe("out");
    expect(codex.backAt).toBe(NOW + 64 * 60 * MINUTE);
    expect(codex.runOut).toBeNull();
  });

  it("does not project a pooled run-out when a spent account refills first", () => {
    const codex = headline([
      account("work", "codex", [window({ id: "primary", usedPercent: 100, resetsAt: iso(10) })]),
      account("personal", "codex", [window({ id: "primary", usedPercent: 80, resetsAt: iso(60) })]),
    ]);
    expect(codex.runOut).toBeNull();
  });
});

describe("windowRunOutAt", () => {
  it("projects only when the window is far enough along and runs out before it resets", () => {
    // Half spent with 80% of the window gone runs out after the reset.
    expect(windowRunOutAt(window({ id: "a", usedPercent: 50, resetsAt: iso(60) }), NOW)).toBeNull();
    expect(windowRunOutAt(window({ id: "b", usedPercent: 3, resetsAt: iso(298) }), NOW)).toBeNull();
    expect(windowRunOutAt(window({ id: "c", usedPercent: 60, resetsAt: iso(150) }), NOW)).toBe(
      NOW + 100 * MINUTE,
    );
  });
});

function iso(minutesFromNow: number) {
  return new Date(NOW + minutesFromNow * MINUTE).toISOString();
}

import type { UsageProviderKind, UsageSummaryInput } from "@t3tools/contracts";
import {
  usageColumns,
  type UsageMetric,
  type UsagePeriodColumn,
} from "@t3tools/client-runtime/usage-ledger";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { PROVIDER_PRESENTATION } from "./usageProviders";

const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();
// The empty chart keeps its frame with a fixed silhouette, so it never reads as real data.
const GHOST_HEIGHTS = [
  0.62, 0.22, 0.18, 0.55, 0.7, 0.6, 0.5, 0.82, 0.24, 0.21, 0.6, 0.92, 0.86, 0.58, 0.88, 0.3, 0.42,
  0.66, 0.9, 0.84, 0.58, 0.6, 0.38, 0.36, 0.64, 0.9, 0.96, 0.9, 0.92, 0.34,
];

function niceMax(peak: number): number {
  if (peak <= 0) return 0;
  const rawStep = peak / 2;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  return Math.ceil(peak / step) * step;
}

function formatDayLong(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function UsageProviderChart({
  merged,
  window,
  metric,
  providers,
  hour12,
  loadingProviders = NONE_LOADING,
  ghost = false,
  className = "h-60",
}: {
  readonly merged: MergedUsage;
  readonly window: UsageSummaryInput;
  readonly metric: UsageMetric;
  /** Stack order, bottom first. */
  readonly providers: readonly UsageProviderKind[];
  readonly hour12: boolean;
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly ghost?: boolean;
  /** Plot height. */
  readonly className?: string;
}) {
  const hourly = window.resolution === "hour";
  const columns = usageColumns(merged, window, metric, providers);
  const max = niceMax(columns.reduce((peak, column) => Math.max(peak, column.total), 0));
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const formatPeriod = (period: string) =>
    hourly ? formatHourShort(period, window.timeZone, hour12) : formatDayShort(period);
  const formatTooltipPeriod = (period: string) =>
    hourly
      ? window.untilTime === undefined
        ? formatPeriod(period)
        : formatRelativeHourShort(period, window.untilTime, window.timeZone, hour12)
      : formatDayLong(period);
  const labelIndexes =
    columns.length <= 7
      ? columns.map((_, index) => index)
      : [0, Math.floor((columns.length - 1) / 2), columns.length - 1];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <div className={cn("relative w-12 shrink-0", className)}>
          {ghost || max === 0
            ? null
            : [max, max / 2, 0].map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-2xs text-muted-foreground tabular-nums"
                  style={{ top: `${(1 - tick / max) * 100}%` }}
                >
                  {tick === 0 ? "0" : format(tick)}
                </span>
              ))}
        </div>
        <ChartPlot
          columns={columns}
          max={max}
          ghost={ghost}
          loadingProviders={loadingProviders}
          format={format}
          formatTooltipPeriod={formatTooltipPeriod}
          className={className}
          ariaLabel={`${hourly ? "Hourly" : "Daily"} ${metric === "tokens" ? "tokens" : "API-price cost"} by provider`}
        />
      </div>
      <div className="relative ms-14 h-4 text-2xs text-muted-foreground">
        {labelIndexes.map((index) => {
          const column = columns[index];
          if (column === undefined) return null;
          const center = ((index + 0.5) / columns.length) * 100;
          return (
            <span
              key={column.period}
              className={cn(
                "absolute whitespace-nowrap",
                labelIndexes.length > 3
                  ? "-translate-x-1/2"
                  : index === 0
                    ? ""
                    : index === columns.length - 1
                      ? "-translate-x-full"
                      : "-translate-x-1/2",
              )}
              style={{
                left:
                  labelIndexes.length > 3 || (index > 0 && index < columns.length - 1)
                    ? `${center}%`
                    : index === 0
                      ? "0%"
                      : "100%",
              }}
            >
              {formatPeriod(column.period)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ChartPlot({
  columns,
  max,
  ghost,
  loadingProviders,
  format,
  formatTooltipPeriod,
  className,
  ariaLabel,
}: {
  readonly columns: readonly UsagePeriodColumn[];
  readonly max: number;
  readonly ghost: boolean;
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly format: (value: number) => string;
  readonly formatTooltipPeriod: (period: string) => string;
  readonly className: string;
  readonly ariaLabel: string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hovered = hoverIndex === null || ghost ? undefined : columns[hoverIndex];

  const positionTooltip = () => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null || hoverIndex === null) return;
    const slot = plot.clientWidth / columns.length;
    const gap = 10;
    const right = (hoverIndex + 1) * slot + gap;
    const left =
      right + tooltip.offsetWidth <= plot.clientWidth
        ? right
        : Math.max(0, hoverIndex * slot - gap - tooltip.offsetWidth);
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places the hover tooltip beside its bar before paint, and again when the plot or tooltip resizes
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;
    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  return (
    <div
      ref={plotRef}
      role="img"
      aria-label={ariaLabel}
      className={cn("relative min-w-0 flex-1", className)}
      onMouseMove={(event) => {
        if (ghost || columns.length === 0) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (bounds.width === 0) return;
        const index = Math.floor(((event.clientX - bounds.left) / bounds.width) * columns.length);
        setHoverIndex(Math.min(columns.length - 1, Math.max(0, index)));
      }}
      onMouseLeave={() => setHoverIndex(null)}
    >
      {ghost || max === 0 ? null : (
        <>
          <span aria-hidden className="absolute inset-x-0 top-0 border-t border-border/60" />
          <span aria-hidden className="absolute inset-x-0 top-1/2 border-t border-border/60" />
        </>
      )}
      <span aria-hidden className="absolute inset-x-0 bottom-0 border-t border-border" />
      <div aria-hidden className="absolute inset-0 flex">
        {columns.map((column, index) => {
          const height = ghost
            ? (GHOST_HEIGHTS[index % GHOST_HEIGHTS.length] ?? 0.5) * 0.9
            : max === 0
              ? 0
              : column.total / max;
          const dimmed = hoverIndex !== null && hoverIndex !== index;
          return (
            <div
              key={column.period}
              className={cn(
                "flex h-full min-w-0 flex-1 items-end justify-center",
                hoverIndex === index && "bg-foreground/4",
              )}
            >
              {height > 0 ? (
                <div
                  className={cn(
                    "flex w-[72%] flex-col-reverse overflow-hidden rounded-t-sm",
                    dimmed && "opacity-45",
                  )}
                  style={{ height: `${height * 100}%` }}
                >
                  {ghost ? (
                    <div className="size-full bg-foreground/6" />
                  ) : (
                    column.bands.map((band, bandIndex) =>
                      band.value > 0 ? (
                        <div
                          key={band.provider}
                          className={cn(
                            "w-full shrink-0 border-background",
                            bandIndex > 0 && "border-b-2",
                            loadingProviders.has(band.provider) && "opacity-40",
                          )}
                          style={{
                            height: `${(band.value / column.total) * 100}%`,
                            backgroundColor: PROVIDER_PRESENTATION[band.provider].color,
                          }}
                        />
                      ) : null,
                    )
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {hovered === undefined ? null : (
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute top-2 z-10 w-52 rounded-lg border bg-popover px-3 py-2.5 text-xs shadow-lg"
          style={{ left: "var(--usage-tooltip-left, 0px)" }}
        >
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-muted-foreground">
            <span>{formatTooltipPeriod(hovered.period)}</span>
            <span className="font-medium text-foreground tabular-nums">
              {format(hovered.total)}
            </span>
          </div>
          {hovered.bands.map((band) => (
            <div key={band.provider} className="flex h-5.5 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-xs"
                style={{ backgroundColor: PROVIDER_PRESENTATION[band.provider].color }}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {PROVIDER_PRESENTATION[band.provider].label}
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  loadingProviders.has(band.provider) ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {format(band.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UsageChartLegend({
  entries,
  format,
}: {
  readonly entries: readonly { readonly provider: UsageProviderKind; readonly value: number }[];
  readonly format: (value: number) => string;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {entries.map((entry) => (
        <span key={entry.provider} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 rounded-xs"
            style={{ backgroundColor: PROVIDER_PRESENTATION[entry.provider].color }}
          />
          {PROVIDER_PRESENTATION[entry.provider].label}
          <span className="font-medium text-foreground tabular-nums">{format(entry.value)}</span>
        </span>
      ))}
    </div>
  );
}

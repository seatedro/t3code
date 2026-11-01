import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  InfoIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageLoadingState,
} from "@t3tools/client-runtime/state/usage-progress";
import {
  formatApproxUsd,
  limitHeadlines,
  previousUsageWindow,
  rankUsageModels,
  rankUsageProviders,
  usageChange,
  usageEfficiency,
  usagePeakAndAverage,
  usageValue,
  type UsageMetric,
} from "@t3tools/client-runtime/usage-ledger";
import {
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
} from "@t3tools/shared/usageLimits";
import { isCompatibleUsageContractVersion, type MergedUsage } from "@t3tools/shared/usageMerge";
import {
  formatCount,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsageContractMismatch,
  formatUsd,
  makeWindow,
  usageSourceMessages,
} from "@t3tools/shared/usageFormat";

import { cn } from "../../lib/utils";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { selectLimitPresentations, UsageLimitsSection } from "./UsageLimits";
import { UsageLimitStrip } from "./UsageLimitStrip";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageChartLegend, UsageProviderChart } from "./UsageProviderChart";
import { UsageModelDialog } from "./UsageModelDialog";
import { UsageSparkline } from "./UsageSparkline";
import {
  ALL_LIMITS_COMMAND,
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
} from "./usageShortcuts";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";

const MODELS_SHOWN = 6;

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageWindowDays(value: number): value is UsagePagePreferences["windowDays"] {
  return WINDOW_OPTIONS.some((option) => option.days === value);
}

function windowOption(days: number) {
  return WINDOW_OPTIONS.find((option) => option.days === days) ?? WINDOW_OPTIONS[2];
}

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

function selectWindow(days: number) {
  const window = makeWindow(days, undefined, days === 1 ? "hour" : "day");
  // Kept with the window so both stay stable inputs to `useUsage` until the period changes.
  return { days, window, previous: previousUsageWindow(window) };
}

function usageLoading(
  showingKept: boolean,
  selectedEnvironments: Parameters<typeof usageLoadingState>[0],
  refreshingUsage: boolean,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  if (showingKept) {
    return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
  }
  const state = usageLoadingState(selectedEnvironments, refreshingUsage);
  const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
  return {
    partial: state.everyProvider || providers.size > 0,
    everyProvider: state.everyProvider,
    providers,
  };
}

/** Keep dialog selection outside UsagePage so opening/closing rerenders only its host. */
const selectedUsageModelKeyAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("usage:selected-model-key"),
);

function selectUsageModel(key: string | null): void {
  appAtomRegistry.set(selectedUsageModelKeyAtom, key);
}

function UsageModelDialogHost({
  models,
  onSetPrice,
  ...dialogProps
}: Omit<Parameters<typeof UsageModelDialog>[0], "model" | "onSetPrice" | "onClose"> & {
  readonly models: MergedUsage["models"];
  readonly onSetPrice: (model: string) => void;
}) {
  const selectedKey = useAtomValue(selectedUsageModelKeyAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the shared selected-model atom on unmount
  useEffect(() => () => selectUsageModel(null), []);
  const model =
    selectedKey === null
      ? undefined
      : models.find((candidate) => `${candidate.provider}:${candidate.model}` === selectedKey);
  if (model === undefined) return null;
  return (
    <UsageModelDialog
      {...dialogProps}
      model={model}
      onSetPrice={() => {
        selectUsageModel(null);
        onSetPrice(model.model);
      }}
      onClose={() => selectUsageModel(null)}
    />
  );
}

export function UsagePage() {
  const navigate = useNavigate();
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    const label = "title" in option ? option.title : option.label;
    return shortcut ? `${label} (${shortcut})` : label;
  };
  const [windowSelection, setWindowSelection] = useState(() =>
    selectWindow(preferences.windowDays),
  );
  const metric = preferences.metric;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const [allLimitsOpen, setAllLimitsOpen] = useState(false);
  const refreshingRef = useRef(false);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const hiddenProviders = new Set(preferences.hiddenProviders);
  const { days: windowDays, window } = windowSelection;
  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    shown,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, hiddenProviders);
  const previous = useUsage(windowSelection.previous, selectedEnvironmentIds, hiddenProviders);
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? window;
  const showingKept = shown !== null && shown.window !== window;
  const previousMerged =
    previous.shown !== null &&
    previous.shown.window === windowSelection.previous &&
    !previous.isPartial
      ? previous.shown.merged
      : null;
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const limitPresentations = selectLimitPresentations(
    presentationsWithProviders,
    selectedEnvironmentIds,
    hiddenProviders,
  );
  const headlines = limitHeadlines(
    collectLimitPools(collectLimitAccounts(limitPresentations), limitsNow),
    limitsNow,
  );
  const externalLinks = collectExternalUsageLinks(limitPresentations);
  const limitNotices = collectLimitNotices(limitPresentations);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const updatePreferences = (patch: Partial<UsagePagePreferences>) => {
    const nextPreferences = { ...preferences, ...patch };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };
  const choosePeriod = (days: number) => {
    if (!isUsageWindowDays(days)) return;
    updatePreferences({ windowDays: days });
    setWindowSelection(selectWindow(days));
  };
  const chooseMetric = (nextMetric: UsageMetric) => updatePreferences({ metric: nextMetric });
  const openAllLimits = () => {
    setLimitsNow(Date.now());
    setAllLimitsOpen(true);
  };
  const refreshLimits = (automatic = false) =>
    // Settled so the timestamp still advances when a refresh throws.
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      ),
    ).then((result) => {
      setLimitsNow(Date.now());
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    const allLimits = command === ALL_LIMITS_COMMAND;
    if (!metricOption && !periodOption && !allLimits) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) chooseMetric(metricOption.value);
    if (periodOption) choosePeriod(periodOption.days);
    if (allLimits) openAllLimits();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for usage metric, period and limits shortcuts
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const refreshAll = () => {
    if (refreshingRef.current) return;
    const nextSelection = selectWindow(windowDays);
    const nextWindow = nextSelection.window;
    const windowMoved =
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime;
    if (windowMoved) setWindowSelection(nextSelection);
    refreshingRef.current = true;
    setIsRefreshing(true);
    void Promise.allSettled([
      canReadDiagnostics ? refresh(windowMoved ? nextWindow : window) : Promise.resolve(),
      refreshLimits(),
    ]).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };
  const connectedLimitsEnvironments = [...presentations]
    .filter(
      ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" &&
        presentation.serverConfig !== null &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId)),
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes provider limits from the server when the connected environment set changes
  useEffect(() => {
    if (connectedLimitsEnvironments) autoRefreshLimits();
  }, [connectedLimitsEnvironments]);

  const hasAllLimits = headlines.length > 0 || limitNotices.length > 0 || externalLinks.length > 0;

  const periodToggle = (
    <ToggleGroup
      aria-label="Usage period"
      variant="segmented"
      value={[String(windowDays)]}
      onValueChange={(next) => {
        const value = next[0];
        if (value) choosePeriod(Number(value));
      }}
    >
      {WINDOW_OPTIONS.map((option) => (
        <Toggle key={option.days} value={String(option.days)} title={shortcutTitle(option)}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
  const metricToggle = (
    <ToggleGroup
      aria-label="Usage metric"
      variant="segmented"
      value={[metric]}
      onValueChange={(next) => {
        const value = next[0];
        if (isUsageMetric(value)) chooseMetric(value);
      }}
    >
      {METRIC_OPTIONS.map((option) => (
        <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );

  return (
    <AppRouteModal label="Usage">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="@container/usage-header flex min-h-12 shrink-0 items-center gap-2 border-b ps-5 pe-2">
          <h1 className="text-sm font-medium text-foreground">Usage</h1>
          <div className="ms-auto hidden shrink-0 items-center gap-2 @3xl/usage-header:flex">
            {periodToggle}
            {metricToggle}
          </div>
          <div className="ms-auto flex shrink-0 items-center gap-1 @3xl/usage-header:hidden">
            <Select
              value={String(windowDays)}
              onValueChange={(value) => choosePeriod(Number(value))}
            >
              <SelectTrigger
                aria-label="Usage period"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>{windowOption(windowDays).label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {WINDOW_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.days}
                    value={String(option.days)}
                    title={shortcutTitle(option)}
                  >
                    {option.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Select
              value={metric}
              onValueChange={(value) => {
                if (isUsageMetric(value)) chooseMetric(value);
              }}
            >
              <SelectTrigger
                aria-label="Usage metric"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>
                  {METRIC_OPTIONS.find((option) => option.value === metric)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {METRIC_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <UsageSourcesMenu
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            hiddenProviders={hiddenProviders}
            onHiddenProvidersChange={(next) => updatePreferences({ hiddenProviders: next })}
            refreshing={isRefreshing}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
            onOpenModelPrices={() => setPriceDialog({})}
          />
          <Button
            onClick={refreshAll}
            aria-label="Refresh usage and limits"
            aria-busy={isRefreshing}
            disabled={isRefreshing || selectedEnvironments.length === 0}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshIcon size="sm" refreshing={isRefreshing} />
          </Button>
          <AppRouteModalClose />
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-8">
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? "Connect an environment to see usage."
                  : "Select an environment to see usage."}
              </p>
            ) : (
              <>
                <UsageLimitStrip
                  headlines={headlines}
                  now={limitsNow}
                  externalLinks={externalLinks}
                  onOpen={() => setLimitsNow(Date.now())}
                  allLimits={hasAllLimits ? openAllLimits : null}
                  onOpenProviderSettings={() => void navigate({ to: "/settings/providers" })}
                />
                {shown === null ? (
                  <LedgerSkeleton />
                ) : !canReadDiagnostics ? (
                  <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
                    {selectedEnvironments.map((environment) => (
                      <p key={environment.environmentId}>
                        {selectedEnvironments.length > 1 ? `${environment.label}: ` : null}
                        {environment.error}
                      </p>
                    ))}
                  </div>
                ) : (
                  <Ledger
                    merged={merged}
                    previous={previousMerged}
                    window={shownWindow}
                    windowDays={windowDays}
                    hour12={hour12}
                    metric={metric}
                    showingKept={showingKept}
                    selectedEnvironments={selectedEnvironments}
                    hiddenProviders={hiddenProviders}
                    refreshingUsage={isRefreshing}
                    onSelectModel={selectUsageModel}
                  />
                )}
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      <UsageModelDialogHost
        models={merged.models}
        environments={selectedEnvironments}
        metric={metric}
        window={shownWindow}
        hour12={hour12}
        onSetPrice={(model) => setPriceDialog({ model })}
      />
      <Dialog open={allLimitsOpen} onOpenChange={setAllLimitsOpen}>
        <DialogPopup className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Limits</DialogTitle>
            <DialogDescription>
              Every window on the selected environments, with each account&apos;s share.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <UsageLimitsSection
              selectedEnvironmentIds={selectedEnvironmentIds}
              hiddenProviders={hiddenProviders}
              now={limitsNow}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </AppRouteModal>
  );
}

function Ledger({
  merged,
  previous,
  window,
  windowDays,
  hour12,
  metric,
  showingKept,
  selectedEnvironments,
  hiddenProviders,
  refreshingUsage,
  onSelectModel,
}: {
  readonly merged: MergedUsage;
  readonly previous: MergedUsage | null;
  readonly window: UsageSummaryInput;
  readonly windowDays: number;
  readonly hour12: boolean;
  readonly metric: UsageMetric;
  readonly showingKept: boolean;
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly refreshingUsage: boolean;
  readonly onSelectModel: (key: string) => void;
}) {
  const [allModels, setAllModels] = useState(false);
  const hourly = window.resolution === "hour";
  const span = windowOption(windowDays).span;
  const loading = usageLoading(showingKept, selectedEnvironments, refreshingUsage, hiddenProviders);
  // Copy the primitive; JSX reads of loading.partial would merge all derivations into one compiler
  // cache scope.
  const loadingPartial = loading.partial === true;
  const loadingProviders = new Set(
    PROVIDER_ORDER.filter((provider) => loading.everyProvider || loading.providers.has(provider)),
  );
  const providers = rankUsageProviders(merged, metric);
  const stack = providers.map((entry) => entry.provider);
  const models = rankUsageModels(merged, window, metric);
  const efficiency = usageEfficiency(merged);
  const { peak, average } = usagePeakAndAverage(merged, window, metric);
  const value = usageValue(merged, metric);
  const change =
    previous === null || loadingPartial ? null : usageChange(value, usageValue(previous, metric));
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const empty = merged.totalTokens === 0 && merged.costUsd === 0 && !loadingPartial;
  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap(
      (environment) =>
        environment.summary?.sources.filter(
          (source) => !hiddenProviders.has(source.fingerprint.provider),
        ) ?? [],
    ),
  );
  const shownModels = allModels ? models : models.slice(0, MODELS_SHOWN);
  const periodWord = hourly ? "hour" : "day";
  const premiumProviders = efficiency.speedPremiumProviders.map(providerLabel);

  return (
    <div aria-busy={loadingPartial} className="flex flex-col gap-8">
      {sourceMessages.map((message) => (
        <p key={message} className="text-sm text-muted-foreground">
          {message}
        </p>
      ))}
      <section className="grid items-end gap-6 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            {metric === "tokens" ? "Tokens processed" : "API-price equivalent"} ·{" "}
            {hourly ? "past 24 hours" : `last ${span}`}
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={cn(
                "text-5xl font-semibold tracking-tight tabular-nums",
                empty ? "text-muted-foreground/50" : "text-foreground",
                figureClass(loadingPartial),
              )}
            >
              {empty ? "0" : metric === "tokens" ? formatTokens(value) : formatApproxUsd(value)}
            </span>
            {empty ? null : (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-xl font-medium text-muted-foreground",
                  figureClass(loadingPartial),
                )}
              >
                {metric === "tokens"
                  ? `≈ ${formatApproxUsd(merged.costUsd)} at API prices`
                  : `${formatTokens(merged.totalTokens)} tokens`}
                {merged.costQuality.unpricedShare > 0 ? (
                  <Popover>
                    <PopoverTrigger
                      openOnHover
                      render={<InlineButton tone="muted" />}
                      aria-label="Unpriced usage details"
                    >
                      <InfoIcon className="size-3.5" aria-hidden />
                    </PopoverTrigger>
                    <PopoverPopup side="top" tooltipStyle>
                      The API-price estimate excludes{" "}
                      {formatPercent(merged.costQuality.unpricedShare)} of records with no known
                      price.
                    </PopoverPopup>
                  </Popover>
                ) : null}
              </span>
            )}
          </p>
          <p className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-sm text-muted-foreground">
            {empty ? (
              <span>
                Usage reads each environment&apos;s session history. It fills in after your first
                turn.
              </span>
            ) : (
              <>
                {change === null ? null : <ChangeLabel change={change} span={span} />}
                <span className={figureClass(loadingPartial)}>
                  {formatCount(merged.sessions)} {merged.sessions === 1 ? "session" : "sessions"}
                </span>
              </>
            )}
          </p>
        </div>
        {empty || peak === null ? null : (
          <dl className={cn("flex gap-9", figureClass(loadingPartial))}>
            <div>
              <dt className="text-xs text-muted-foreground">Busiest {periodWord}</dt>
              <dd className="mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums">
                {hourly
                  ? formatHourShort(peak.period, window.timeZone, hour12)
                  : formatDayShort(peak.period)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {hourly ? "Hourly" : "Daily"} average
              </dt>
              <dd className="mt-1 text-xl font-semibold tracking-tight text-foreground tabular-nums">
                {format(average)}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <UsageProviderChart
          merged={merged}
          window={window}
          metric={metric}
          providers={stack}
          hour12={hour12}
          loadingProviders={loadingProviders}
          ghost={empty}
          className={empty ? "h-40" : "h-60"}
        />
        {empty ? null : <UsageChartLegend entries={providers} format={format} />}
      </section>

      {empty ? null : (
        <section className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,0.9fr)]">
          <div className="flex min-w-0 flex-col">
            <ColumnHeading aside={metric === "tokens" ? "share of tokens" : "share of cost"}>
              Providers
            </ColumnHeading>
            <div
              aria-hidden
              className="mt-1 mb-3.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full"
            >
              {providers.map((entry) => (
                <span
                  key={entry.provider}
                  className="h-full min-w-0.5"
                  style={{
                    flexGrow: entry.value,
                    backgroundColor: PROVIDER_PRESENTATION[entry.provider].color,
                  }}
                />
              ))}
            </div>
            {providers.map((entry) => (
              <div
                key={entry.provider}
                className="grid h-7.5 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 text-sm"
              >
                <ProviderMark provider={entry.provider} className="size-3.5" />
                <span className="truncate text-foreground">{providerLabel(entry.provider)}</span>
                <span
                  className={cn(
                    "font-medium text-foreground tabular-nums",
                    figureClass(loadingProviders.has(entry.provider)),
                  )}
                >
                  {format(entry.value)}{" "}
                  <span className="font-normal text-muted-foreground">
                    {formatPercent(entry.share, 0)}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <div className="flex min-w-0 flex-col">
            <ColumnHeading aside={hourly ? "24-hour trend" : `${windowDays}-day trend`}>
              Models
            </ColumnHeading>
            <div className="mt-1 flex flex-col">
              {shownModels.map(({ model, value: modelValue, trend }) => {
                const key = `${model.provider}:${model.model}`;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onSelectModel(key)}
                    className="grid h-8 grid-cols-[1rem_minmax(0,1fr)_4rem_3.5rem] items-center gap-2.5 border-b border-border/50 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                  >
                    <ProviderMark provider={model.provider} className="size-3.5" />
                    <span className="truncate text-foreground">{model.model}</span>
                    <span className={figureClass(loadingProviders.has(model.provider))}>
                      <UsageSparkline
                        values={trend}
                        color={PROVIDER_PRESENTATION[model.provider].color}
                      />
                    </span>
                    <span
                      className={cn(
                        "text-right text-foreground tabular-nums",
                        modelValue === null && "text-muted-foreground",
                        figureClass(loadingProviders.has(model.provider)),
                      )}
                    >
                      {modelValue === null ? "Unpriced" : format(modelValue)}
                    </span>
                  </button>
                );
              })}
            </div>
            {models.length > MODELS_SHOWN ? (
              <div className="mt-2 flex">
                <Button variant="ghost-muted" size="xs" onClick={() => setAllModels(!allModels)}>
                  {allModels ? "Show fewer" : `All ${models.length} models`}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col">
            <ColumnHeading>Efficiency</ColumnHeading>
            <dl className={cn("mt-1 flex flex-col gap-3.5", figureClass(loadingPartial))}>
              {efficiency.cacheHitShare === null ? null : (
                <EfficiencyFigure
                  label="Input read from cache"
                  value={formatPercent(efficiency.cacheHitShare, 0)}
                  aside={
                    efficiency.cacheSavingsUsd > 0
                      ? `saved ${formatApproxUsd(efficiency.cacheSavingsUsd)}`
                      : undefined
                  }
                />
              )}
              {efficiency.outputShare === null ? null : (
                <EfficiencyFigure
                  label="Output"
                  value={formatPercent(efficiency.outputShare, 1)}
                  aside="of tokens"
                />
              )}
              {efficiency.speedPremiumUsd > 0 ? (
                <EfficiencyFigure
                  label="Fast mode premium"
                  value={formatUsd(efficiency.speedPremiumUsd)}
                  aside={
                    premiumProviders.length > 0 ? `on ${premiumProviders.join(", ")}` : undefined
                  }
                />
              ) : null}
            </dl>
          </div>
        </section>
      )}
    </div>
  );
}

function ChangeLabel({ change, span }: { readonly change: number; readonly span: string }) {
  const percent = Math.round(Math.abs(change) * 100);
  if (percent === 0) return <span>Level with the previous {span}</span>;
  const Arrow = change > 0 ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span>
      <span className="inline-flex items-center gap-0.5 font-medium text-foreground tabular-nums">
        <Arrow className="size-3.5" aria-label={change > 0 ? "Up" : "Down"} />
        {percent}%
      </span>{" "}
      vs the previous {span}
    </span>
  );
}

function ColumnHeading({
  children,
  aside,
}: {
  readonly children: string;
  readonly aside?: string;
}) {
  return (
    <h2 className="mb-2 flex items-baseline justify-between gap-3 text-sm font-medium text-foreground">
      {children}
      {aside ? <span className="text-xs font-normal text-muted-foreground">{aside}</span> : null}
    </h2>
  );
}

function EfficiencyFigure({
  label,
  value,
  aside,
}: {
  readonly label: string;
  readonly value: string;
  readonly aside?: string | undefined;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tracking-tight text-foreground tabular-nums">
          {value}
        </span>
        {aside ? <span className="text-xs text-muted-foreground">{aside}</span> : null}
      </dd>
    </div>
  );
}

function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>
          {environment.label}: {environment.error}
        </span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          Counted once across environments sharing a transcript directory:{" "}
          {duplicateSources.join(", ")}
        </span>
      ) : null}
    </div>
  );
}

/** Which environments and providers the page counts, plus the model price overrides. */
function UsageSourcesMenu({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  hiddenProviders,
  onHiddenProvidersChange,
  refreshing,
  isPartial,
  duplicateSources,
  contractMismatches,
  onOpenModelPrices,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onHiddenProvidersChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
  readonly refreshing: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly onOpenModelPrices: () => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const environmentLabel = allSelected
    ? "All environments"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} environments`;
  const label =
    hiddenProviders.size === 0
      ? environmentLabel
      : `${environmentLabel} · ${PROVIDER_ORDER.length - hiddenProviders.size} providers`;
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    contractMismatches.length > 0;

  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="sm" />} className="min-w-0">
        <span className="min-w-0 truncate">{label}</span>
        {hasIssue ? (
          <CircleAlertIcon
            className="text-warning-foreground"
            aria-label="Some environments could not report usage"
          />
        ) : (
          <ChevronDownIcon aria-hidden />
        )}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          All environments
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const progress = usageEnvironmentProgress(environment, refreshing);
          const status =
            environment.error !== null
              ? "Unavailable"
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? "Update required"
                : !environment.isConnected
                  ? "Connecting…"
                  : progress.phase === "loading"
                    ? "Scanning…"
                    : progress.phase === "stale"
                      ? "Refreshing…"
                      : progress.phase === "partway"
                        ? updatingProvidersLabel(progress.providers, providerLabel)
                        : "Ready";
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                <span
                  className={cn(
                    "shrink-0 text-xs text-muted-foreground",
                    environment.error !== null && "text-destructive",
                  )}
                >
                  {status}
                </span>
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No environments connected.</p>
        ) : null}
        {isPartial ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Totals are partial while selected environments scan.
          </p>
        ) : null}
        <UsageCoverageNotice
          environments={selectedEnvironments}
          duplicateSources={duplicateSources}
          contractMismatches={contractMismatches}
        />
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Providers</MenuGroupLabel>
          {PROVIDER_ORDER.map((provider) => (
            <MenuCheckboxItem
              key={provider}
              checked={!hiddenProviders.has(provider)}
              closeOnClick={false}
              onCheckedChange={(checked) =>
                onHiddenProvidersChange(
                  PROVIDER_ORDER.filter((entry) =>
                    entry === provider ? !checked : hiddenProviders.has(entry),
                  ),
                )
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <ProviderMark provider={provider} className="size-3.5" />
                <span className="truncate">{providerLabel(provider)}</span>
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={onOpenModelPrices}>
          <SlidersHorizontalIcon aria-hidden />
          Model prices
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function LedgerSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-4 w-56" />
      </div>
      <Skeleton className="ms-14 h-60" />
      <div className="grid gap-10 lg:grid-cols-3">
        {[0, 1, 2].map((column) => (
          <div key={column} className="flex flex-col gap-2.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

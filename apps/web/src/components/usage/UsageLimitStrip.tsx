import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import {
  isBlockedSession,
  limitSeverity,
  limitWindowLabel,
  limitWindowNoun,
  usageProviderOfDriver,
  type LimitHeadline,
  type LimitSeverity,
} from "@t3tools/client-runtime/usage-ledger";
import {
  formatDuration,
  paceRemainingPercent,
  resetCreditChoices,
  type LimitAccount,
  type LimitPoolWindow,
  type ResetCreditChoice,
} from "@t3tools/shared/usageLimits";
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  GaugeIcon,
  TicketIcon,
  TrendingUpIcon,
} from "lucide-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ResetCreditDialog, useResetCredit } from "./UsageLimits";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageExternalLink {
  readonly label: string;
  readonly url: string;
}

const SEVERITY_TEXT: Record<LimitSeverity, string> = {
  ok: "text-foreground",
  low: "text-warning-foreground",
  out: "text-error-foreground",
};

function providerName(driver: string, long = false): string {
  const provider = usageProviderOfDriver(driver);
  if (long && provider !== null) return PROVIDER_PRESENTATION[provider].label;
  return providerClients.get(driver as never)?.label ?? driver;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

type Redeemable = LimitAccount & { readonly redeem: NonNullable<LimitAccount["redeem"]> };
type OnRedeem = (accountKey: string, choice: ResetCreditChoice) => void;

function redeemableAccounts(headline: LimitHeadline): readonly Redeemable[] {
  return headline.pool.accounts.filter(
    (account): account is Redeemable =>
      account.redeem !== null && (account.limits.resetCredits?.availableCount ?? 0) > 0,
  );
}

/**
 * The always-visible limits row: one chip per provider showing its tightest window. A chip opens
 * every window in detail. Reset-credit confirms live here, outside the popovers, because dialogs
 * stack under popovers and a popover unmounts as the confirm opens.
 */
export function UsageLimitStrip({
  headlines,
  now,
  externalLinks,
  onOpen,
  allLimits,
  onOpenProviderSettings,
}: {
  readonly headlines: readonly LimitHeadline[];
  readonly now: number;
  readonly externalLinks: readonly UsageExternalLink[];
  /** A chip opened; refresh the clock its countdowns read. */
  readonly onOpen: () => void;
  readonly allLimits: (() => void) | null;
  readonly onOpenProviderSettings: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  // Kept after close so the dialog's text survives its exit animation.
  const [choice, setChoice] = useState<ResetCreditChoice | null>(null);
  const redeemable = headlines.flatMap(redeemableAccounts);
  return (
    <section aria-label="Limits" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {headlines.length === 0 ? (
          <span className="inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground">
            <GaugeIcon className="size-3.5" aria-hidden />
            No subscription limits reported
          </span>
        ) : (
          headlines.map((headline) => (
            <LimitChip
              key={headline.pool.driver}
              headline={headline}
              now={now}
              externalLinks={headline.pool.driver === "codex" ? externalLinks : []}
              onOpen={onOpen}
              onRedeem={(accountKey, next) => {
                setChoice(next);
                setConfirming(accountKey);
              }}
            />
          ))
        )}
        {allLimits ? (
          <Button variant="ghost-muted" size="sm" onClick={allLimits}>
            All limits
            <ChevronRightIcon aria-hidden />
          </Button>
        ) : headlines.length === 0 ? (
          <Button variant="ghost-muted" size="sm" onClick={onOpenProviderSettings}>
            Providers settings
            <ChevronRightIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {redeemable.map((account) => (
        <AccountRedeemer
          key={account.key}
          account={account}
          choice={choice}
          open={confirming === account.key}
          onOpenChange={(open) => setConfirming(open ? account.key : null)}
        />
      ))}
    </section>
  );
}

function LimitChip({
  headline,
  now,
  externalLinks,
  onOpen,
  onRedeem,
}: {
  readonly headline: LimitHeadline;
  readonly now: number;
  readonly externalLinks: readonly UsageExternalLink[];
  readonly onOpen: () => void;
  readonly onRedeem: OnRedeem;
}) {
  const [open, setOpen] = useState(false);
  const { pool, binding, severity, backAt } = headline;
  const noun = limitWindowNoun(pool, binding);
  const resetsAt = binding.resets[0]?.at ?? null;
  const name = providerName(pool.driver);
  const summary =
    severity === "out"
      ? `${name}: out${backAt === null ? "" : `, back in ${formatDuration(backAt - now)}`}`
      : `${name}: ${binding.remainingPercent}% of the ${noun} limit left`;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={summary}
            className={cn(
              "inline-flex h-9 items-center gap-2.5 rounded-lg border bg-card ps-2.5 pe-3 text-sm text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-accent",
              severity === "low" && "border-warning/40",
              severity === "out" && "border-error/45",
            )}
          />
        }
      >
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={name}
          iconClassName="size-3.5"
        />
        <span>{name}</span>
        {severity === "out" ? (
          <span className="flex items-baseline gap-1.5">
            <span className="font-medium text-error-foreground">Out</span>
            {backAt === null ? null : (
              <span className="text-muted-foreground tabular-nums">
                · back in {formatDuration(backAt - now)}
              </span>
            )}
          </span>
        ) : (
          <>
            <LimitMeter
              remaining={binding.remainingPercent}
              severity={severity}
              className="h-1 w-11"
            />
            <span className="flex items-baseline gap-1.5">
              <span className={cn("font-medium tabular-nums", SEVERITY_TEXT[severity])}>
                {binding.remainingPercent}% left
              </span>
              <span className="text-muted-foreground">
                · {noun}
                {severity === "low" && resetsAt !== null
                  ? ` · ${formatDuration(resetsAt - now)}`
                  : ""}
              </span>
            </span>
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" sideOffset={6} className="w-84 max-w-[calc(100vw-2rem)]">
        <LimitDetail
          headline={headline}
          now={now}
          externalLinks={externalLinks}
          onRedeem={(accountKey, next) => {
            setOpen(false);
            onRedeem(accountKey, next);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

function accountsLabel(accounts: readonly LimitAccount[]): string | null {
  if (accounts.length < 2) return null;
  const names = accounts.flatMap((account) => (account.displayName ? [account.displayName] : []));
  return names.length === accounts.length ? names.join(", ") : `${accounts.length} accounts`;
}

function LimitDetail({
  headline,
  now,
  externalLinks,
  onRedeem,
}: {
  readonly headline: LimitHeadline;
  readonly now: number;
  readonly externalLinks: readonly UsageExternalLink[];
  readonly onRedeem: OnRedeem;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { pool, windows, severity, runOut } = headline;
  const accounts = accountsLabel(pool.accounts);
  const redeemable = redeemableAccounts(headline);
  const runOutLabel = runOut === null ? null : limitWindowLabel(pool, runOut.window);
  const runOutSubject =
    runOut === null
      ? null
      : runOut.window.kind === "session"
        ? "the session"
        : runOutLabel === "Weekly"
          ? "the weekly limit"
          : runOutLabel;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <h3 className="flex min-w-0 items-center gap-2 font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={providerName(pool.driver)}
          iconClassName="size-4"
        />
        <span className="truncate">{providerName(pool.driver, true)}</span>
        {accounts ? (
          <span className="truncate text-xs font-normal text-muted-foreground">· {accounts}</span>
        ) : null}
      </h3>
      <div className="flex flex-col gap-3.5">
        {windows.map((window) => (
          <LimitWindowRow
            key={`${window.kind}:${window.id}`}
            label={limitWindowLabel(pool, window)}
            window={window}
            now={now}
            timestampFormat={timestampFormat}
          />
        ))}
      </div>
      {runOut !== null && severity !== "out" ? (
        <p className="flex gap-2 border-t pt-3 text-xs text-warning-foreground">
          <TrendingUpIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            At this pace, {runOutSubject} runs out around{" "}
            {formatUpcomingTimestamp(iso(runOut.at), timestampFormat, now)}
          </span>
        </p>
      ) : null}
      {redeemable.length > 0 || externalLinks.length > 0 ? (
        <div className="flex flex-col gap-2 border-t pt-3">
          {redeemable.map((account) => (
            <CreditRow
              key={account.key}
              account={account}
              primary={severity === "out"}
              now={now}
              showAccount={redeemable.length > 1}
              onRedeem={(next) => onRedeem(account.key, next)}
            />
          ))}
          {externalLinks.map((link) => (
            <Button
              key={link.url}
              variant="ghost-muted"
              size="sm"
              className="self-start"
              onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
            >
              {link.label}
              <ExternalLinkIcon aria-hidden />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LimitWindowRow({
  label,
  window,
  now,
  timestampFormat,
}: {
  readonly label: string;
  readonly window: LimitPoolWindow;
  readonly now: number;
  readonly timestampFormat: Parameters<typeof formatUpcomingTimestamp>[1];
}) {
  const blocked = isBlockedSession(window);
  const severity = limitSeverity(window.remainingPercent);
  // Pooled accounts each run their own clock; the earliest reset is the next change.
  const nextReset = window.resets[0]?.at ?? null;
  const pace =
    blocked || severity === "out" || window.members.length !== 1
      ? null
      : paceRemainingPercent(window.members[0]!.window, now);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            blocked ? "text-muted-foreground" : SEVERITY_TEXT[severity],
          )}
        >
          {blocked ? "Blocked" : `${window.remainingPercent}% left`}
        </span>
      </div>
      <LimitMeter
        remaining={blocked ? 0 : window.remainingPercent}
        severity={blocked ? "ok" : severity}
        pace={pace}
        className="h-1.5"
      />
      <span className="text-xs text-muted-foreground tabular-nums">
        {blocked
          ? "Opens when the weekly limit resets"
          : nextReset === null
            ? "No reset time reported"
            : `Resets ${formatUpcomingTimestamp(iso(nextReset), timestampFormat, now)} · in ${formatDuration(nextReset - now)}`}
      </span>
    </div>
  );
}

/** Neutral while there is headroom; amber when low; an empty red-ringed track when spent. */
function LimitMeter({
  remaining,
  severity,
  pace = null,
  className,
}: {
  readonly remaining: number;
  readonly severity: LimitSeverity;
  readonly pace?: number | null;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block shrink-0 rounded-full",
        severity === "out" ? "bg-error/12 ring-1 ring-error/35 ring-inset" : "bg-foreground/8",
        className,
      )}
    >
      {severity === "out" || remaining <= 0 ? null : (
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            severity === "low" ? "bg-warning" : "bg-foreground/85",
          )}
          style={{ width: `${remaining}%` }}
        />
      )}
      {pace === null ? null : (
        <span
          className="absolute -inset-y-[3px] w-0.5 -translate-x-1/2 rounded-full bg-muted-foreground"
          style={{ left: `clamp(1px, ${pace}%, calc(100% - 1px))` }}
        />
      )}
    </span>
  );
}

function CreditRow({
  account,
  primary,
  now,
  showAccount,
  onRedeem,
}: {
  readonly account: Redeemable;
  readonly primary: boolean;
  readonly now: number;
  readonly showAccount: boolean;
  readonly onRedeem: (choice: ResetCreditChoice) => void;
}) {
  const environmentId: EnvironmentId = account.redeem.environmentId;
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const credits = account.limits.resetCredits;
  if (!credits) return null;
  return resetCreditChoices(credits, account.redeem.input, now, true)
    .filter((choice) => choice.availableCount > 0)
    .map((choice) => (
      <div key={choice.key} className="flex items-center gap-3">
        <Button
          size="sm"
          variant={primary ? "default" : "outline"}
          disabled={!canManage}
          onClick={() => {
            if (readEnvironmentScope(environmentId, AuthProvidersManageScope)) onRedeem(choice);
          }}
        >
          <TicketIcon aria-hidden />
          Use reset credit
        </Button>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {choice.summary}
          {showAccount ? ` · ${account.displayName ?? account.email ?? account.key}` : ""}
        </span>
      </div>
    ));
}

function AccountRedeemer({
  account,
  choice,
  open,
  onOpenChange,
}: {
  readonly account: Redeemable;
  readonly choice: ResetCreditChoice | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const redeem = useResetCredit(account.redeem.environmentId);
  return (
    <>
      <ResetCreditDialog
        open={open}
        onOpenChange={onOpenChange}
        choice={choice}
        onConfirm={() => {
          onOpenChange(false);
          void redeem.redeem(choice);
        }}
        disabled={!redeem.canManageProviders}
      />
      {redeem.busy || redeem.status ? (
        <span role="status" className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {providerName(account.driver)}
            {account.displayName ? ` · ${account.displayName}` : ""}
          </span>{" "}
          {redeem.busy ? "Using reset credit…" : redeem.status}
        </span>
      ) : null}
    </>
  );
}

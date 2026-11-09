import type { AutomationRunMark } from "@t3tools/client-runtime/user-message";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Automation runs and other agents' messages sit on the left as cards, apart from your own bubbles. */
export const TRIGGER_CARD_CLASS_NAME =
  "min-w-0 w-full max-w-xl rounded-xl border border-border/70 bg-card text-card-foreground";

const TILE_CLASS_NAME = {
  automation: "bg-info/12 text-info",
  agent: "bg-primary/10 text-primary",
} as const;

export function TriggerCardHeader(props: {
  icon: LucideIcon;
  /** Read before the title by screen readers, for cards whose title doesn't say what sent them. */
  kind?: string;
  tone: keyof typeof TILE_CLASS_NAME;
  title: string;
  detail: string;
  marks?: ReadonlyArray<AutomationRunMark> | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      data-scroll-anchor-ignore
      onClick={props.onToggle}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          TILE_CLASS_NAME[props.tone],
        )}
      >
        <Icon className="size-4 stroke-2" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-sm">
          {props.kind === undefined ? null : <span className="sr-only">{props.kind}: </span>}
          {props.title}
        </span>
        <span className="truncate text-muted-foreground text-xs">{props.detail}</span>
      </span>
      {props.marks !== undefined && props.marks.length > 1 ? <RunBars marks={props.marks} /> : null}
      <ChevronDownIcon
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          props.expanded && "rotate-180",
        )}
      />
    </button>
  );
}

const BAR_MIN_PX = 3;
const BAR_MAX_PX = 20;

function RunBars({ marks }: { marks: ReadonlyArray<AutomationRunMark> }) {
  const failed = marks.filter((mark) => mark.failed).length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex h-5 shrink-0 items-end gap-0.5" />}
        aria-label={runSummary(marks.length, failed)}
      >
        {marks.map((mark, index) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- Bars are positions in the run history.
            key={index}
            className={cn(
              "w-[3px] rounded-xs",
              mark.failed
                ? "bg-destructive/70"
                : mark.current
                  ? "bg-info"
                  : "bg-muted-foreground/30",
            )}
            style={{ height: BAR_MIN_PX + mark.level * (BAR_MAX_PX - BAR_MIN_PX) }}
          />
        ))}
      </TooltipTrigger>
      <TooltipPopup>{runSummary(marks.length, failed)}</TooltipPopup>
    </Tooltip>
  );
}

function runSummary(runs: number, failed: number) {
  return `Last ${runs} runs here, by how long each worked${failed > 0 ? ` · ${failed} failed` : ""}`;
}

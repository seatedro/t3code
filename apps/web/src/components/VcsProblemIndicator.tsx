import {
  type VcsTerminology,
  vcsProblemDescription,
  vcsProblemLabel,
} from "@t3tools/client-runtime/state/vcs";
import type { VcsWorkspaceProblem } from "@t3tools/contracts";
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** `action` renders beside the badge, for a fix such as repairing a stale workspace. */
export function VcsProblemIndicator({
  problem,
  terminology,
  action,
}: {
  problem: VcsWorkspaceProblem;
  terminology: VcsTerminology;
  action?: ReactNode;
}) {
  const repairable = problem.code === "stale";
  return (
    <span
      className="inline-flex min-w-0 shrink-0 items-center gap-1.5"
      data-vcs-problem={problem.code}
    >
      <Tooltip>
        <TooltipTrigger render={<Badge variant={repairable ? "warning" : "error"} size="sm" />}>
          <CircleAlertIcon aria-hidden />
          {vcsProblemLabel(problem, terminology)}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{vcsProblemDescription(problem)}</TooltipPopup>
      </Tooltip>
      {action}
    </span>
  );
}

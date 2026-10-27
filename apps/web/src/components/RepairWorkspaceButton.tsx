import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WORKSPACE_REPAIR_CONFIRMATION,
  workspaceRepairSummary,
} from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId } from "@t3tools/contracts";
import { WrenchIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function RepairWorkspaceButton(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const allowed = useAtomValue(vcsEnvironment.repairWorkspace.permissionAtom(props.environmentId));
  const repairWorkspace = useAtomCommand(vcsEnvironment.repairWorkspace, { reportFailure: false });
  const [pending, setPending] = useState(false);

  const repair = async () => {
    if (pending) return;
    const confirmed =
      (await requestConfirmDialog(
        `${WORKSPACE_REPAIR_CONFIRMATION.title}\n${WORKSPACE_REPAIR_CONFIRMATION.message}`,
      )) ?? true;
    if (!confirmed) return;
    setPending(true);
    const result = await repairWorkspace({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    });
    setPending(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", ...workspaceRepairSummary(result.value) });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not repair workspace",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!allowed || pending}
      onClick={() => void repair()}
    >
      <WrenchIcon />
      {pending ? "Repairing…" : "Repair"}
    </Button>
  );
}

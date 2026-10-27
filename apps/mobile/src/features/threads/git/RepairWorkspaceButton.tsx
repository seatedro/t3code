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
import { useState } from "react";

import { Button } from "../../../components/ui/Button";
import * as Dialog from "../../../components/ui/Dialog";
import { useAtomCommand } from "../../../state/use-atom-command";
import { vcsEnvironment } from "../../../state/vcs";

export function RepairWorkspaceButton(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const allowed = useAtomValue(vcsEnvironment.repairWorkspace.permissionAtom(props.environmentId));
  const repairWorkspace = useAtomCommand(vcsEnvironment.repairWorkspace, { reportFailure: false });
  const [pending, setPending] = useState(false);

  const repair = async () => {
    setPending(true);
    const result = await repairWorkspace({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    });
    setPending(false);
    if (result._tag === "Success") {
      const summary = workspaceRepairSummary(result.value);
      Dialog.alert(summary.title, summary.description);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not repair workspace",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <Button
      label="Repair"
      icon="arrow.clockwise"
      disabled={!allowed}
      loading={pending}
      onPress={() =>
        Dialog.confirm({
          ...WORKSPACE_REPAIR_CONFIRMATION,
          onConfirm: () => void repair(),
        })
      }
    />
  );
}

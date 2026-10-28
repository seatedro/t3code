import type { VcsRepairWorkspaceResult } from "@t3tools/contracts";

export const WORKSPACE_REPAIR_CONFIRMATION = {
  title: "Repair this stale workspace?",
  message:
    "T3 Code first saves the files on disk under a git ref, then updates the workspace to jj's current state. Divergent changes stay as they are for you to resolve.",
  confirmText: "Repair",
} as const;

export function workspaceRepairSummary(result: VcsRepairWorkspaceResult): {
  readonly title: string;
  readonly description: string;
} {
  if (!result.repaired) {
    return { title: "Workspace is not stale", description: "Nothing needed repair." };
  }
  const saved = `Files on disk were saved under ${result.preservedRef}.`;
  return {
    title: "Workspace repaired",
    description:
      result.divergentChangeIds.length === 0
        ? saved
        : `${saved} Divergent changes to resolve: ${result.divergentChangeIds
            .map((id) => id.slice(0, 8))
            .join(", ")}.`,
  };
}

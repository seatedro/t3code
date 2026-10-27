import {
  selectVcsKind,
  type VcsTerminology,
  vcsTerminologyFor,
} from "@t3tools/client-runtime/state/vcs";

import { useEnvironmentQuerySelector } from "./query";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import { useThreadSelection } from "./use-thread-selection";
import { vcsEnvironment } from "./vcs";

/** Subscribes to the repository kind alone, so other status changes don't re-render. */
export function useSelectedThreadVcsTerminology(): VcsTerminology {
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  return vcsTerminologyFor(
    useEnvironmentQuerySelector(
      selectedThread !== null && selectedThreadCwd !== null
        ? vcsEnvironment.status({
            environmentId: selectedThread.environmentId,
            input: { cwd: selectedThreadCwd },
          })
        : null,
      selectVcsKind,
    ),
  );
}

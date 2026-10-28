import {
  selectVcsKind,
  type VcsTerminology,
  vcsTerminologyFor,
} from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentQuerySelector } from "../state/query";
import { vcsEnvironment } from "../state/vcs";

/** Subscribes to the repository kind alone, so other status changes don't re-render. */
export function useVcsTerminology(
  environmentId: EnvironmentId | null,
  cwd: string | null | undefined,
): VcsTerminology {
  return vcsTerminologyFor(
    useEnvironmentQuerySelector(
      environmentId !== null && cwd
        ? vcsEnvironment.status({ environmentId, input: { cwd } })
        : null,
      selectVcsKind,
    ),
  );
}

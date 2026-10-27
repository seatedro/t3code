import {
  type VcsTerminology,
  vcsProblemDescription,
  vcsProblemLabel,
} from "@t3tools/client-runtime/state/vcs";
import type { VcsWorkspaceProblem } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";

/** `action` renders at the row's trailing edge, for a fix such as repairing a stale workspace. */
export function VcsProblemRow(props: {
  readonly problem: VcsWorkspaceProblem;
  readonly terminology: VcsTerminology;
  readonly action?: ReactNode;
}) {
  return (
    <View className="bg-grouped-card" accessibilityRole="alert">
      <ListRowLayout
        icon="exclamationmark.triangle"
        tone={props.problem.code === "stale" ? "default" : "danger"}
        label={vcsProblemLabel(props.problem, props.terminology)}
        description={vcsProblemDescription(props.problem)}
        accessory={props.action}
      />
    </View>
  );
}

// temp: connection timings. Remove with the commit that added it.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  ConnectionTimings,
  createConnectionRoundTripAtoms,
} from "@t3tools/client-runtime/connection";

import { connectionAtomRuntime } from "~/connection/runtime";
import { isElectron } from "~/env";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { FoldedSettingsSection } from "./FoldedSettingsSection";

const roundTripAtom = createConnectionRoundTripAtoms(connectionAtomRuntime);

function TimingRows({ rows }: { readonly rows: ReadonlyArray<ConnectionTimings.TimingRow> }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      {rows.map((row) => (
        <div key={`${row.label}:${row.value}`} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-all font-mono tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EnvironmentTimings({
  timings,
}: {
  readonly timings: ConnectionTimings.EnvironmentTimings;
}) {
  // Mounted only while the section is open, so round trips are measured only then.
  const measureRoundTrip = useAtomRefresh(roundTripAtom(timings.environmentId));
  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{timings.label}</p>
          <p className="text-xs text-muted-foreground">
            Round trip {ConnectionTimings.roundTripSummary(timings.roundTrips)}
          </p>
        </div>
        <Button size="xs" variant="outline" onClick={measureRoundTrip}>
          Measure now
        </Button>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">Connects</p>
        {timings.connects.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          timings.connects.map((connect) => (
            <div key={connect.id} className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {ConnectionTimings.connectTitle(connect)}
              </p>
              <TimingRows rows={ConnectionTimings.connectRows(connect)} />
            </div>
          ))
        )}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">Thread opens</p>
        {timings.threadOpens.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          timings.threadOpens.map((open) => (
            <div key={open.id} className="space-y-1">
              <p className="text-xs text-muted-foreground">
                {ConnectionTimings.threadOpenTitle(open)}
              </p>
              <TimingRows rows={ConnectionTimings.threadOpenRows(open)} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function ConnectionTimingsSection() {
  const timings = useAtomValue(ConnectionTimings.timingsAtom);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: "connection timings",
  });
  return (
    <FoldedSettingsSection
      id="connection-timings"
      title="Connection timings"
      summary="Temporary. Kept in memory only."
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={timings.length === 0}
          onClick={() =>
            copyToClipboard(
              ConnectionTimings.timingsJson(isElectron ? "desktop" : "web", timings),
              undefined,
            )
          }
        >
          {isCopied ? "Copied" : "Copy JSON"}
        </Button>
      }
    >
      {timings.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Nothing measured yet. Records start when an environment connects.
        </p>
      ) : (
        timings.map((environment) => (
          <EnvironmentTimings key={environment.environmentId} timings={environment} />
        ))
      )}
    </FoldedSettingsSection>
  );
}

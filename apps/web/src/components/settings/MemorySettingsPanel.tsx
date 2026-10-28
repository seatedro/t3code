import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MemoryEntry, MemoryNode } from "@t3tools/contracts";
import { BrainIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type MemoryView = "memories" | "summaries" | "agents";

const counted = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

const blockLabel = ({ lo, size }: { lo: number; size: number }) =>
  size === 1 ? `#${lo}` : `#${lo}-${lo + size - 1}`;

/** Memory lives in one environment, so a scope switch starts the page fresh. */
export function MemorySettingsPanel() {
  const { environment } = useSettingsScope();
  return <MemorySettingsBody key={environment?.environmentId ?? ""} />;
}

function MemorySettingsBody() {
  const { environment } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  const label = environment?.label ?? "this environment";

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="memory"
        title="Memory"
        icon={<BrainIcon className="size-4 text-muted-foreground" />}
      >
        <SettingsRow
          serverScoped
          {...searchableSetting("memory")}
          settingKeys={["memoryEnabled"]}
          description="Agents read their memory at the start of each thread and note what's worth keeping. Turning this off hides the memory tool from agents; your memories stay here. Threads already running keep the tools they started with."
          control={
            <ScopedSwitch
              settingKeys={["memoryEnabled"]}
              checked={settings.memoryEnabled}
              onCheckedChange={(checked) => updateSettings({ memoryEnabled: Boolean(checked) })}
              aria-label="Agents use memory"
            />
          }
        />
        {environmentId === null ? (
          <SettingsRow
            title={`${label} is not connected`}
            description="Connect to it to browse its memory."
          />
        ) : (
          <MemoryCountsRow environmentId={environmentId} label={label} />
        )}
      </SettingsSection>
      {environmentId === null ? null : (
        <MemoryBrowser environmentId={environmentId} label={label} />
      )}
    </SettingsPageContainer>
  );
}

function useMemoryOverview(environmentId: EnvironmentId) {
  return useEnvironmentQuery(serverEnvironment.memoryOverview({ environmentId, input: {} }));
}

function MemoryCountsRow({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const overview = useMemoryOverview(environmentId).data;
  return (
    <SettingsRow
      title={`Stored on ${label}`}
      description={
        overview?.since
          ? `Each environment keeps its own memory. The first was noted on ${overview.since}.`
          : "Each environment keeps its own memory."
      }
      control={
        overview ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            <Badge variant="secondary" size="control">
              {counted(overview.memories - overview.pruned, "memory", "memories")}
            </Badge>
            <Badge variant="secondary" size="control">
              {counted(overview.summaries, "summary", "summaries")}
            </Badge>
            {overview.pendingCompressions > 0 ? (
              <Badge variant="warning" size="control">
                {counted(overview.pendingCompressions, "compression", "compressions")} pending
              </Badge>
            ) : null}
          </div>
        ) : null
      }
    />
  );
}

/** Runs a memory edit, reports a failure, and makes every memory view read again. */
function useMemoryEdit(environmentId: EnvironmentId) {
  const bump = useAtomSet(serverEnvironment.memoryRevision(environmentId));
  return async <A, E>(run: () => Promise<AtomCommandResult<A, E>>, failureTitle: string) => {
    const result = await run();
    if (result._tag === "Success") {
      bump((revision) => revision + 1);
      return result.value;
    }
    if (!isAtomCommandInterrupted(result))
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    return null;
  };
}

function MemoryBrowser({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const [view, setView] = useState<MemoryView>("memories");
  const overview = useMemoryOverview(environmentId);
  const canEdit = useAtomValue(serverEnvironment.pruneMemories.permissionAtom(environmentId));

  return (
    <>
      <SettingsSection
        id="memory-browse"
        title="Browse"
        variant="plain"
        headerAction={
          <ToggleGroup
            variant="segmented"
            value={[view]}
            onValueChange={(next) => {
              const selected = next[0];
              if (selected === "memories" || selected === "summaries" || selected === "agents")
                setView(selected);
            }}
            aria-label="Memory view"
          >
            <ToggleGroupItem value="memories">Memories</ToggleGroupItem>
            <ToggleGroupItem value="summaries">Summaries</ToggleGroupItem>
            <ToggleGroupItem value="agents">What agents see</ToggleGroupItem>
          </ToggleGroup>
        }
      >
        <div className="px-3 sm:px-4">
          {overview.error ? (
            <p className="text-sm text-destructive">{overview.error}</p>
          ) : view === "memories" ? (
            <MemoryList environmentId={environmentId} canEdit={canEdit} />
          ) : view === "summaries" ? (
            <SummaryTree
              environmentId={environmentId}
              roots={overview.data?.roots ?? []}
              canEdit={canEdit}
            />
          ) : (
            <WakePreview wake={overview.data?.wake ?? ""} />
          )}
        </div>
      </SettingsSection>
      <SettingsSection id="memory-danger" title="Danger zone">
        <PurgeRow
          environmentId={environmentId}
          label={label}
          canEdit={canEdit}
          counts={overview.data ?? null}
        />
      </SettingsSection>
    </>
  );
}

function MemoryList({
  environmentId,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [pages, setPages] = useState<ReadonlyArray<number>>([]);
  const [selected, setSelected] = useState<ReadonlyMap<number, MemoryEntry>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const prune = useAtomCommand(serverEnvironment.pruneMemories, { label: "memory prune" });
  const edit = useMemoryEdit(environmentId);

  const toggle = (entry: MemoryEntry, checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(entry.id, entry);
      else next.delete(entry.id);
      return next;
    });

  const confirmPrune = async () => {
    const result = await edit(
      () => prune({ environmentId, input: { ids: [...selected.keys()] } }),
      "Could not prune memories",
    );
    setConfirming(false);
    if (result === null) return;
    setSelected(new Map());
    toastManager.add({
      type: "success",
      title: `Pruned ${counted(result.pruned, "memory", "memories")}`,
      description:
        result.summariesDropped > 0
          ? `${counted(result.summariesDropped, "summary", "summaries")} will be rebuilt by agents on their next nap.`
          : undefined,
    });
  };

  return (
    <div className="space-y-2">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          placeholder="Search memories (regex)"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setPages([]);
          }}
          aria-label="Search memories"
        />
      </InputGroup>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {[undefined, ...pages].map((before, index) => (
          <MemoryListPage
            key={`${deferredQuery}:${before ?? "newest"}`}
            environmentId={environmentId}
            query={deferredQuery}
            before={before}
            isLast={index === pages.length}
            selected={selected}
            canEdit={canEdit}
            onToggle={toggle}
            onMore={(next) => setPages((current) => [...current, next])}
          />
        ))}
      </div>
      {selected.size > 0 ? (
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-sm">
          <span className="text-muted-foreground">{selected.size} selected</span>
          <div className="flex gap-1.5">
            <Button size="xs" variant="ghost-muted" onClick={() => setSelected(new Map())}>
              Clear
            </Button>
            <Button size="xs" variant="destructive-outline" onClick={() => setConfirming(true)}>
              Prune {selected.size}
            </Button>
          </div>
        </div>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Prune {counted(selected.size, "memory", "memories")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their text is deleted and they show as Pruned; their numbers stay so every summary
              keeps its place. Summaries from the earliest pruned memory onward are dropped, and
              agents rebuild them on their next nap without the pruned text.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mx-6 mb-4 max-h-40 space-y-1 overflow-y-auto border-l-2 border-border pl-3 text-sm text-muted-foreground">
            {[...selected.values()]
              .toSorted((left, right) => left.id - right.id)
              .map((entry) => (
                <div key={entry.id}>
                  #{entry.id} {entry.text}
                </div>
              ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmPrune()}>
              Prune
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function MemoryListPage({
  environmentId,
  query,
  before,
  isLast,
  selected,
  canEdit,
  onToggle,
  onMore,
}: {
  readonly environmentId: EnvironmentId;
  readonly query: string;
  readonly before: number | undefined;
  readonly isLast: boolean;
  readonly selected: ReadonlyMap<number, MemoryEntry>;
  readonly canEdit: boolean;
  readonly onToggle: (entry: MemoryEntry, checked: boolean) => void;
  readonly onMore: (before: number) => void;
}) {
  const page = useEnvironmentQuery(
    serverEnvironment.memoryList({
      environmentId,
      input: {
        ...(query === "" ? {} : { query }),
        ...(before === undefined ? {} : { before }),
      },
    }),
  );
  if (page.error) return <p className="px-3 py-2 text-sm text-destructive">{page.error}</p>;
  if (page.data === null)
    return <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>;
  if (before === undefined && page.data.entries.length === 0)
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">
        {query === "" ? "No memories yet." : "No memory matches."}
      </p>
    );
  return (
    <>
      {page.data.entries.map((entry) => {
        const checked = selected.has(entry.id);
        return (
          <label
            key={entry.id}
            className={`flex items-start gap-3 px-3 py-2 text-sm ${checked ? "bg-accent/50" : ""}`}
          >
            <Checkbox
              checked={checked}
              disabled={!canEdit || entry.text === null}
              onCheckedChange={(next) => onToggle(entry, Boolean(next))}
              aria-label={`Select memory ${entry.id}`}
            />
            <span className="w-12 shrink-0 font-mono text-xs leading-5 text-muted-foreground">
              #{entry.id}
            </span>
            <span className="w-20 shrink-0 font-mono text-xs leading-5 text-muted-foreground">
              {entry.date}
            </span>
            {entry.text === null ? (
              <span className="text-muted-foreground italic">Pruned</span>
            ) : (
              <span className="min-w-0 flex-1 break-words text-foreground">{entry.text}</span>
            )}
          </label>
        );
      })}
      {isLast && page.data.nextBefore !== null ? (
        <div className="px-3 py-1.5">
          <Button size="xs" variant="ghost-muted" onClick={() => onMore(page.data!.nextBefore!)}>
            Load older
          </Button>
        </div>
      ) : null}
    </>
  );
}

function SummaryTree({
  environmentId,
  roots,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly roots: ReadonlyArray<MemoryNode>;
  readonly canEdit: boolean;
}) {
  if (roots.length === 0) return <p className="text-sm text-muted-foreground">No memories yet.</p>;
  return (
    <div className="rounded-lg border border-border bg-card p-1">
      {roots.map((node) => (
        <SummaryNode
          key={`${node.lo}:${node.size}`}
          environmentId={environmentId}
          node={node}
          depth={0}
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}

function SummaryNode({
  environmentId,
  node,
  depth,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: MemoryNode;
  readonly depth: number;
  readonly canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const forget = useAtomCommand(serverEnvironment.forgetMemorySummary, { label: "memory forget" });
  const edit = useMemoryEdit(environmentId);
  const expandable = node.size > 1;
  const textClass =
    node.kind === "pending"
      ? "text-warning-foreground"
      : node.kind === "pruned"
        ? "text-muted-foreground italic"
        : "text-foreground";
  const text =
    node.kind === "pending"
      ? "Not compressed yet. An agent compresses it on its next nap."
      : node.kind === "pruned"
        ? "Pruned"
        : node.text;

  const forgetSummary = async () => {
    const result = await edit(
      () => forget({ environmentId, input: { lo: node.lo, size: node.size } }),
      "Could not forget summary",
    );
    if (result !== null)
      toastManager.add({
        type: "success",
        title: `Forgot ${counted(result.summariesDropped, "summary", "summaries")}`,
        description: "Agents rebuild them on their next nap.",
      });
  };

  return (
    <>
      <div
        className="group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40"
        style={{ paddingLeft: 8 + depth * 18 }}
      >
        <button
          type="button"
          className="mt-0.5 size-4 shrink-0 text-muted-foreground disabled:invisible"
          disabled={!expandable}
          onClick={() => setOpen((current) => !current)}
          aria-label={open ? `Collapse ${blockLabel(node)}` : `Expand ${blockLabel(node)}`}
        >
          {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        </button>
        <span
          className={`w-[5.5rem] shrink-0 font-mono text-xs leading-5 ${node.size === 1 ? "text-muted-foreground" : "text-info-foreground"}`}
        >
          {blockLabel(node)}
        </span>
        <span className={`min-w-0 flex-1 break-words ${textClass}`}>{text}</span>
        {canEdit && node.kind === "summary" ? (
          <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <Button size="xs" variant="ghost-destructive" onClick={() => void forgetSummary()}>
              Forget
            </Button>
          </span>
        ) : null}
      </div>
      {open ? (
        <SummaryChildren
          environmentId={environmentId}
          node={node}
          depth={depth + 1}
          canEdit={canEdit}
        />
      ) : null}
    </>
  );
}

function SummaryChildren({
  environmentId,
  node,
  depth,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: MemoryNode;
  readonly depth: number;
  readonly canEdit: boolean;
}) {
  const children = useEnvironmentQuery(
    serverEnvironment.memoryChildren({ environmentId, input: { lo: node.lo, size: node.size } }),
  );
  if (children.error)
    return (
      <p className="py-1 text-sm text-destructive" style={{ paddingLeft: 8 + depth * 18 }}>
        {children.error}
      </p>
    );
  return (
    <>
      {(children.data?.nodes ?? []).map((child) => (
        <SummaryNode
          key={`${child.lo}:${child.size}`}
          environmentId={environmentId}
          node={child}
          depth={depth}
          canEdit={canEdit}
        />
      ))}
    </>
  );
}

function WakePreview({ wake }: { readonly wake: string }) {
  const lines = wake.split("\n").length;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Exactly what <code className="font-mono">memory wake</code> returns to an agent:{" "}
        {counted(lines, "line", "lines")}, about{" "}
        {Math.max(1, Math.round(wake.length / 4 / 100) / 10)}k tokens.
      </p>
      <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
        {wake}
      </pre>
    </div>
  );
}

function PurgeRow({
  environmentId,
  label,
  canEdit,
  counts,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly canEdit: boolean;
  readonly counts: { readonly memories: number; readonly summaries: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const purge = useAtomCommand(serverEnvironment.purgeMemory, { label: "memory purge" });
  const edit = useMemoryEdit(environmentId);

  const confirmPurge = async () => {
    const result = await edit(() => purge({ environmentId, input: {} }), "Could not purge memory");
    setOpen(false);
    setTyped("");
    if (result !== null)
      toastManager.add({
        type: "success",
        title: `Purged ${label}'s memory`,
        description: `${counted(result.memories, "memory", "memories")} and ${counted(result.summaries, "summary", "summaries")} deleted.`,
      });
  };

  return (
    <>
      <SettingsRow
        title="Purge memory"
        description={`Delete every memory and summary on ${label}. Agents start with an empty memory.`}
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canEdit || counts === null || counts.memories === 0}
            onClick={() => setOpen(true)}
          >
            Purge…
          </Button>
        }
      />
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setTyped("");
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Purge {label}'s memory?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes all {counted(counts?.memories ?? 0, "memory", "memories")} and{" "}
              {counted(counts?.summaries ?? 0, "summary", "summaries")}. Agents on {label} start
              with an empty memory. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="mx-6 mb-4 space-y-1.5">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-medium text-foreground">{label}</span> to confirm.
            </p>
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              aria-label="Environment name"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={typed.trim() !== label}
              onClick={() => void confirmPurge()}
            >
              Purge
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

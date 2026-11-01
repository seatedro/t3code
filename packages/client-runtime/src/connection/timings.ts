// temp: connection timings. Measures connects, thread opens and round trips so clients can be
// compared. Memory only: nothing persists or leaves the device. Remove with `git revert`.
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type { PreparedConnection } from "./model.ts";
import { type ConnectionRouteKind, connectionRouteKind, routeHttpBaseUrl } from "./routes.ts";

const MAX_CONNECTS = 10;
const MAX_THREAD_OPENS = 20;
const MAX_ROUND_TRIPS = 20;

/** Offsets are milliseconds from the start of the record that owns the snapshot. */
export interface SnapshotTiming {
  readonly source: "http" | "socket";
  readonly requestAtMs: number | null;
  /** Request sent to response headers. */
  readonly responseMs: number | null;
  /** Response headers to the whole body. */
  readonly bodyMs: number | null;
  /** Whole body to decoded value. */
  readonly decodeMs: number | null;
  readonly decodedAtMs: number | null;
  /** Applied to client state. */
  readonly appliedAtMs: number | null;
  /** Decompressed body size. */
  readonly bytes: number | null;
  /** The Content-Length header, when the response had one. */
  readonly wireBytes: number | null;
}

export interface ConnectRouteTiming {
  readonly kind: ConnectionRouteKind;
  readonly address: string | null;
}

export interface ConnectAttemptTiming {
  readonly route: ConnectRouteTiming;
  readonly startMs: number;
  readonly outcome: "pending" | "connected" | "failed" | "interrupted";
  readonly error: string | null;
  /** Resolve and authorize: descriptor, ticket or token, protocol check. */
  readonly authMs: number | null;
  readonly descriptorMs: number | null;
  readonly ticketMs: number | null;
  readonly tokenMs: number | null;
  /** Authorized to WebSocket open. */
  readonly socketOpenMs: number | null;
  /** WebSocket open to the first server config. */
  readonly configMs: number | null;
  readonly totalMs: number | null;
}

export interface ConnectTiming {
  readonly id: number;
  readonly startedAt: string;
  readonly outcome: "pending" | "connected" | "failed" | "interrupted";
  readonly route: ConnectRouteTiming | null;
  /** Connect start to the start of the route that connected: route checks and failed routes. */
  readonly routeMs: number | null;
  readonly authMs: number | null;
  readonly descriptorMs: number | null;
  readonly ticketMs: number | null;
  readonly tokenMs: number | null;
  readonly socketOpenMs: number | null;
  readonly configMs: number | null;
  /** Connect start to connected. */
  readonly readyMs: number | null;
  readonly shell: SnapshotTiming | null;
  readonly attempts: ReadonlyArray<ConnectAttemptTiming>;
}

export interface ThreadOpenTiming {
  readonly id: number;
  readonly threadId: ThreadId;
  readonly startedAt: string;
  /** What the thread showed before the server answered. */
  readonly cache: "memory" | "disk" | "none" | null;
  readonly cacheMs: number | null;
  readonly snapshot: SnapshotTiming | null;
  /** Open to caught up with the server. */
  readonly liveMs: number | null;
}

export interface RoundTripTiming {
  readonly at: string;
  readonly route: ConnectRouteTiming | null;
  readonly ms: number | null;
  readonly error: string | null;
}

export interface EnvironmentTimings {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connects: ReadonlyArray<ConnectTiming>;
  readonly threadOpens: ReadonlyArray<ThreadOpenTiming>;
  readonly roundTrips: ReadonlyArray<RoundTripTiming>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface StepTimes {
  descriptorMs: number | null;
  ticketMs: number | null;
  tokenMs: number | null;
}

interface AttemptDraft extends StepTimes {
  readonly connect: ConnectDraft;
  readonly route: Mutable<ConnectRouteTiming>;
  readonly startedAt: number;
  outcome: ConnectAttemptTiming["outcome"];
  error: string | null;
  preparedAt: number | null;
  openedAt: number | null;
  endedAt: number | null;
}

interface ConnectDraft {
  readonly id: number;
  readonly environmentId: EnvironmentId;
  readonly startedAt: number;
  readonly startedAtIso: string;
  outcome: ConnectTiming["outcome"];
  endedAt: number | null;
  readonly attempts: Array<AttemptDraft>;
  shell: Mutable<SnapshotTiming> | null;
}

interface ThreadOpenDraft extends Mutable<Omit<ThreadOpenTiming, "snapshot">> {
  readonly startedAtMs: number;
  snapshot: Mutable<SnapshotTiming> | null;
}

interface EnvironmentDraft {
  label: string;
  readonly connects: Array<ConnectDraft>;
  readonly threadOpens: Array<ThreadOpenDraft>;
  readonly roundTrips: Array<RoundTripTiming>;
}

const environments = new Map<EnvironmentId, EnvironmentDraft>();
const attemptsByPrepared = new WeakMap<PreparedConnection, AttemptDraft>();
const listeners = new Set<() => void>();
let nextId = 1;

const now = () => performance.now();
const isoNow = () => DateTime.formatIso(DateTime.nowUnsafe());
const elapsed = (from: number | null, to: number | null) =>
  from === null || to === null ? null : Math.round(to - from);

function changed() {
  for (const listener of listeners) listener();
}

function environmentDraft(environmentId: EnvironmentId, label?: string): EnvironmentDraft {
  let draft = environments.get(environmentId);
  if (draft === undefined) {
    draft = { label: label ?? environmentId, connects: [], threadOpens: [], roundTrips: [] };
    environments.set(environmentId, draft);
  } else if (label !== undefined) {
    draft.label = label;
  }
  return draft;
}

function pushBounded<A>(items: Array<A>, item: A, max: number) {
  items.push(item);
  if (items.length > max) items.splice(0, items.length - max);
}

class CurrentConnect extends Context.Reference<ConnectDraft | null>(
  "@t3tools/client-runtime/connection/timings/CurrentConnect",
  { defaultValue: () => null },
) {}

class CurrentAttempt extends Context.Reference<AttemptDraft | null>(
  "@t3tools/client-runtime/connection/timings/CurrentAttempt",
  { defaultValue: () => null },
) {}

function attemptError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const { _tag, reason, detail } = cause as {
      readonly _tag?: unknown;
      readonly reason?: unknown;
      readonly detail?: unknown;
    };
    return [_tag, reason, detail].filter((part) => typeof part === "string").join(": ");
  }
  return String(cause);
}

/** Wraps `ConnectionDriver.connect`. */
export const measureConnect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  entry: ConnectionCatalogEntry,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const environment = environmentDraft(entry.target.environmentId, entry.target.label);
    const draft: ConnectDraft = {
      id: nextId++,
      environmentId: entry.target.environmentId,
      startedAt: now(),
      startedAtIso: isoNow(),
      outcome: "pending",
      endedAt: null,
      attempts: [],
      shell: null,
    };
    pushBounded(environment.connects, draft, MAX_CONNECTS);
    changed();
    return effect.pipe(
      Effect.provideService(CurrentConnect, draft),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          draft.endedAt = now();
          draft.outcome = Exit.isSuccess(exit)
            ? "connected"
            : Cause.hasInterrupts(exit.cause)
              ? "interrupted"
              : "failed";
          changed();
        }),
      ),
    );
  });

/** Wraps one route of a connect. */
export const measureAttempt = <A extends { readonly prepared: PreparedConnection }, E, R>(
  effect: Effect.Effect<A, E, R>,
  route: ConnectionRoute,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.service(CurrentConnect), (connect) => {
    if (connect === null) return effect;
    const draft: AttemptDraft = {
      connect,
      route: { kind: connectionRouteKind(route), address: routeHttpBaseUrl(route) },
      startedAt: now(),
      outcome: "pending",
      error: null,
      preparedAt: null,
      openedAt: null,
      endedAt: null,
      descriptorMs: null,
      ticketMs: null,
      tokenMs: null,
    };
    connect.attempts.push(draft);
    changed();
    return effect.pipe(
      Effect.provideService(CurrentAttempt, draft),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          draft.endedAt = now();
          if (Exit.isSuccess(exit)) {
            draft.outcome = "connected";
            draft.route.address = exit.value.prepared.httpBaseUrl;
            attemptsByPrepared.set(exit.value.prepared, draft);
          } else if (Cause.hasInterrupts(exit.cause)) {
            draft.outcome = "interrupted";
          } else {
            draft.outcome = "failed";
            draft.error = Option.match(Cause.findErrorOption(exit.cause), {
              onNone: () => "defect",
              onSome: attemptError,
            });
          }
          changed();
        }),
      ),
    );
  });

export const markPrepared: Effect.Effect<void> = Effect.flatMap(
  Effect.service(CurrentAttempt),
  (attempt) =>
    Effect.sync(() => {
      if (attempt === null) return;
      attempt.preparedAt = now();
      changed();
    }),
);

export const markSocketOpen: Effect.Effect<void> = Effect.flatMap(
  Effect.service(CurrentAttempt),
  (attempt) =>
    Effect.sync(() => {
      if (attempt === null || attempt.openedAt !== null) return;
      attempt.openedAt = now();
      changed();
    }),
);

/** Adds the duration of one part of authorizing a route to the current attempt. */
export const step =
  (name: "descriptor" | "ticket" | "token") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.service(CurrentAttempt), (attempt) => {
      if (attempt === null) return effect;
      const startedAt = now();
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            const key = `${name}Ms` as const;
            attempt[key] = (attempt[key] ?? 0) + Math.round(now() - startedAt);
          }),
        ),
      );
    });

interface HttpProbe {
  readonly requestedAt: number;
  respondedAt: number | null;
  bodyAt: number | null;
  bytes: number | null;
  wireBytes: number | null;
}

function measuredClient(client: HttpClient.HttpClient, probe: HttpProbe): HttpClient.HttpClient {
  return HttpClient.tap(client, (response) =>
    Effect.suspend(() => {
      probe.respondedAt = now();
      const length = Number(response.headers["content-length"]);
      probe.wireBytes = Number.isFinite(length) ? length : null;
      // The response caches its body, so the decoder reads this same buffer.
      return response.arrayBuffer.pipe(
        Effect.tap((body) =>
          Effect.sync(() => {
            probe.bodyAt = now();
            probe.bytes = body.byteLength;
          }),
        ),
        Effect.ignore,
      );
    }),
  );
}

function snapshotFromProbe(
  probe: HttpProbe,
  decodedAt: number,
  startedAt: number,
): Mutable<SnapshotTiming> {
  return {
    source: "http",
    requestAtMs: elapsed(startedAt, probe.requestedAt),
    responseMs: elapsed(probe.requestedAt, probe.respondedAt),
    bodyMs: elapsed(probe.respondedAt, probe.bodyAt),
    decodeMs: elapsed(probe.bodyAt, decodedAt),
    decodedAtMs: elapsed(startedAt, decodedAt),
    appliedAtMs: null,
    bytes: probe.bytes,
    wireBytes: probe.wireBytes,
  };
}

const measureHttp =
  (httpClient: HttpClient.HttpClient, record: (probe: HttpProbe, decodedAt: number) => void) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>> =>
    Effect.suspend(() => {
      const probe: HttpProbe = {
        requestedAt: now(),
        respondedAt: null,
        bodyAt: null,
        bytes: null,
        wireBytes: null,
      };
      return effect.pipe(
        Effect.tap(() => Effect.sync(() => record(probe, now()))),
        Effect.provideService(HttpClient.HttpClient, measuredClient(httpClient, probe)),
      );
    });

function latestConnect(environmentId: EnvironmentId): ConnectDraft | undefined {
  return environments.get(environmentId)?.connects.at(-1);
}

/** Provides the shell loader's HTTP client and records the first shell snapshot of a connect. */
export const measureShellSnapshot = (
  prepared: PreparedConnection,
  httpClient: HttpClient.HttpClient,
) =>
  measureHttp(httpClient, (probe, decodedAt) => {
    const connect = attemptsByPrepared.get(prepared)?.connect;
    if (connect === undefined || connect.shell !== null) return;
    connect.shell = snapshotFromProbe(probe, decodedAt, connect.startedAt);
    changed();
  });

/** Called when a shell snapshot, from HTTP or the socket, reaches client state. */
export function markShellSnapshotApplied(environmentId: EnvironmentId) {
  const connect = latestConnect(environmentId);
  if (connect === undefined) return;
  const appliedAtMs = elapsed(connect.startedAt, now());
  if (connect.shell === null) {
    connect.shell = {
      source: "socket",
      requestAtMs: null,
      responseMs: null,
      bodyMs: null,
      decodeMs: null,
      decodedAtMs: null,
      appliedAtMs,
      bytes: null,
      wireBytes: null,
    };
  } else if (connect.shell.appliedAtMs === null) {
    connect.shell.appliedAtMs = appliedAtMs;
  } else {
    return;
  }
  changed();
}

export interface ThreadOpenHandle {
  readonly cached: (source: "memory" | "disk" | "none") => void;
  readonly item: (kind: string) => void;
}

export function startThreadOpen(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadOpenHandle {
  const draft: ThreadOpenDraft = {
    id: nextId++,
    threadId,
    startedAt: isoNow(),
    startedAtMs: now(),
    cache: null,
    cacheMs: null,
    snapshot: null,
    liveMs: null,
  };
  pushBounded(environmentDraft(environmentId).threadOpens, draft, MAX_THREAD_OPENS);
  changed();
  return {
    cached: (source) => {
      draft.cache = source;
      draft.cacheMs = elapsed(draft.startedAtMs, now());
      changed();
    },
    item: (kind) => {
      if (kind === "synchronized" && draft.liveMs === null) {
        draft.liveMs = elapsed(draft.startedAtMs, now());
        changed();
      } else if (kind === "snapshot" && draft.snapshot === null) {
        const at = elapsed(draft.startedAtMs, now());
        draft.snapshot = {
          source: "socket",
          requestAtMs: null,
          responseMs: null,
          bodyMs: null,
          decodeMs: null,
          decodedAtMs: at,
          appliedAtMs: at,
          bytes: null,
          wireBytes: null,
        };
        changed();
      }
    },
  };
}

/** Provides the thread loader's HTTP client and records the snapshot on the thread's latest open. */
export const measureThreadSnapshot = (
  prepared: PreparedConnection,
  threadId: ThreadId,
  httpClient: HttpClient.HttpClient,
) =>
  measureHttp(httpClient, (probe, decodedAt) => {
    const opens = environments.get(prepared.environmentId)?.threadOpens ?? [];
    const open = opens.findLast((draft) => draft.threadId === threadId);
    if (open === undefined || open.snapshot !== null) return;
    open.snapshot = snapshotFromProbe(probe, decodedAt, open.startedAtMs);
    changed();
  });

export function recordRoundTrip(
  environmentId: EnvironmentId,
  prepared: PreparedConnection | null,
  result: { readonly ms: number } | { readonly error: string },
) {
  const attempt = prepared === null ? undefined : attemptsByPrepared.get(prepared);
  pushBounded(
    environmentDraft(environmentId).roundTrips,
    {
      at: isoNow(),
      route: attempt === undefined ? null : { ...attempt.route },
      ms: "ms" in result ? Math.round(result.ms) : null,
      error: "error" in result ? result.error : null,
    },
    MAX_ROUND_TRIPS,
  );
  changed();
}

function readAttempt(draft: AttemptDraft): ConnectAttemptTiming {
  return {
    route: { ...draft.route },
    startMs: Math.round(draft.startedAt - draft.connect.startedAt),
    outcome: draft.outcome,
    error: draft.error,
    authMs: elapsed(draft.startedAt, draft.preparedAt),
    descriptorMs: draft.descriptorMs,
    ticketMs: draft.ticketMs,
    tokenMs: draft.tokenMs,
    socketOpenMs: elapsed(draft.preparedAt, draft.openedAt),
    configMs: draft.outcome === "connected" ? elapsed(draft.openedAt, draft.endedAt) : null,
    totalMs: elapsed(draft.startedAt, draft.endedAt),
  };
}

function readConnect(draft: ConnectDraft): ConnectTiming {
  const attempts = draft.attempts.map(readAttempt);
  const chosen = attempts.findLast((attempt) => attempt.outcome === "connected") ?? attempts.at(-1);
  return {
    id: draft.id,
    startedAt: draft.startedAtIso,
    outcome: draft.outcome,
    route: chosen?.route ?? null,
    routeMs: chosen?.startMs ?? null,
    authMs: chosen?.authMs ?? null,
    descriptorMs: chosen?.descriptorMs ?? null,
    ticketMs: chosen?.ticketMs ?? null,
    tokenMs: chosen?.tokenMs ?? null,
    socketOpenMs: chosen?.socketOpenMs ?? null,
    configMs: chosen?.configMs ?? null,
    readyMs: draft.outcome === "connected" ? elapsed(draft.startedAt, draft.endedAt) : null,
    shell: draft.shell === null ? null : { ...draft.shell },
    attempts,
  };
}

function readTimings(): ReadonlyArray<EnvironmentTimings> {
  return Array.from(environments, ([environmentId, draft]) => ({
    environmentId,
    label: draft.label,
    connects: draft.connects.map(readConnect).reverse(),
    threadOpens: draft.threadOpens
      .map(({ startedAtMs: _startedAtMs, snapshot, ...open }) => ({
        ...open,
        snapshot: snapshot === null ? null : { ...snapshot },
      }))
      .reverse(),
    roundTrips: draft.roundTrips.slice().reverse(),
  }));
}

/** Every environment's records, newest first. Recomputed only while something reads it. */
export const timingsAtom: Atom.Atom<ReadonlyArray<EnvironmentTimings>> = Atom.make((get) => {
  const listener = () => get.setSelf(readTimings());
  listeners.add(listener);
  get.addFinalizer(() => listeners.delete(listener));
  return readTimings();
}).pipe(Atom.withLabel("connection-timings"));

export const environmentTimingsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(timingsAtom).find((timings) => timings.environmentId === environmentId) ?? null,
  ).pipe(Atom.withLabel(`connection-timings:${environmentId}`)),
);

export function timingsJson(
  client: string,
  timings: ReadonlyArray<EnvironmentTimings> | EnvironmentTimings,
): string {
  return JSON.stringify(
    {
      client,
      copiedAt: isoNow(),
      environments: Array.isArray(timings) ? timings : [timings],
    },
    null,
    2,
  );
}

export interface TimingRow {
  readonly label: string;
  readonly value: string;
}

function formatMs(ms: number | null): string {
  if (ms === null) return "n/a";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** UTC time of day. */
function formatClock(iso: string): string {
  return `${iso.slice(11, 19)}Z`;
}

function formatRoute(route: ConnectRouteTiming | null): string {
  return route === null ? "n/a" : `${route.kind} ${route.address ?? ""}`.trim();
}

function formatParts(parts: ReadonlyArray<readonly [string, number | null]>): string {
  const known = parts.filter(([, ms]) => ms !== null);
  return known.map(([name, ms]) => `${name} ${formatMs(ms)}`).join(" · ");
}

function snapshotRow(label: string, snapshot: SnapshotTiming | null): TimingRow {
  if (snapshot === null) return { label, value: "n/a" };
  const size =
    snapshot.bytes === null
      ? null
      : snapshot.wireBytes === null || snapshot.wireBytes === snapshot.bytes
        ? formatBytes(snapshot.bytes)
        : `${formatBytes(snapshot.bytes)} (${formatBytes(snapshot.wireBytes)} on the wire)`;
  const parts = formatParts([
    ["response", snapshot.responseMs],
    ["body", snapshot.bodyMs],
    ["decode", snapshot.decodeMs],
  ]);
  return {
    label,
    value: [
      `${snapshot.source} at ${formatMs(snapshot.appliedAtMs ?? snapshot.decodedAtMs)}`,
      size,
      parts === "" ? null : parts,
    ]
      .filter((part) => part !== null)
      .join(" · "),
  };
}

export function connectTitle(connect: ConnectTiming): string {
  return `${formatClock(connect.startedAt)} · ${connect.outcome}`;
}

export function connectRows(connect: ConnectTiming): ReadonlyArray<TimingRow> {
  const authParts = formatParts([
    ["descriptor", connect.descriptorMs],
    ["ticket", connect.ticketMs],
    ["token", connect.tokenMs],
  ]);
  const failed = connect.attempts.filter((attempt) => attempt.outcome === "failed");
  return [
    {
      label: "Route",
      value:
        connect.attempts.length > 1
          ? `${formatRoute(connect.route)} (${connect.attempts.length} routes tried)`
          : formatRoute(connect.route),
    },
    { label: "Route selection", value: formatMs(connect.routeMs) },
    {
      label: "Auth",
      value:
        authParts === "" ? formatMs(connect.authMs) : `${formatMs(connect.authMs)} (${authParts})`,
    },
    { label: "WebSocket open", value: formatMs(connect.socketOpenMs) },
    { label: "Server config", value: formatMs(connect.configMs) },
    { label: "Connected after", value: formatMs(connect.readyMs) },
    snapshotRow("Shell snapshot", connect.shell),
    ...failed.map((attempt) => ({
      label: "Failed route",
      value: `${formatRoute(attempt.route)} after ${formatMs(attempt.totalMs)}: ${attempt.error ?? ""}`,
    })),
  ];
}

export function threadOpenTitle(open: ThreadOpenTiming): string {
  return `${formatClock(open.startedAt)} · thread ${open.threadId.slice(0, 8)}`;
}

export function threadOpenRows(open: ThreadOpenTiming): ReadonlyArray<TimingRow> {
  return [
    {
      label: "Cache first",
      value: open.cache === null ? "n/a" : `${open.cache} (${formatMs(open.cacheMs)})`,
    },
    snapshotRow("Snapshot", open.snapshot),
    { label: "Live after", value: formatMs(open.liveMs) },
  ];
}

export function roundTripSummary(roundTrips: ReadonlyArray<RoundTripTiming>): string {
  const [latest] = roundTrips;
  if (latest === undefined) return "Not measured yet";
  const samples = roundTrips.flatMap((sample) => (sample.ms === null ? [] : [sample.ms]));
  const median =
    samples.length === 0 ? null : [...samples].sort((a, b) => a - b)[samples.length >> 1]!;
  const current = latest.ms === null ? `failed: ${latest.error ?? "unknown"}` : formatMs(latest.ms);
  return `${current} · median ${formatMs(median)} of ${samples.length} · ${formatRoute(latest.route)}`;
}

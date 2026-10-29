import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import {
  bootstrapRemoteBearerSession,
  type RemoteEnvironmentAuthError,
  requestRemoteTailnetSession,
} from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { connectionRoutes, routeEntry, sshTargetKey } from "./routes.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface TailnetConnectionInput {
  /** A machine name, MagicDNS name, tailnet IP, or URL. */
  readonly address: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerTailnet: (
      input: TailnetConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `That address reaches ${label}, a different machine. Add it as its own environment instead.`,
  });
}

/** Everything checked before a credential is spent, in the order a wrong machine is refused. */
const prepareBearerRoute = Effect.fn("clientRuntime.connection.onboarding.prepareBearerRoute")(
  function* (input: {
    readonly descriptor: ExecutionEnvironmentDescriptor;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly expectedEnvironmentId: EnvironmentId | undefined;
    readonly admission?: "tailnet-trust";
  }) {
    const descriptor = input.descriptor;
    if (
      input.expectedEnvironmentId !== undefined &&
      descriptor.environmentId !== input.expectedEnvironmentId
    ) {
      return yield* differentMachineError(descriptor.label);
    }
    const connectionId = bearerConnectionId(descriptor.environmentId, input.httpBaseUrl);
    const route = {
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        wsBaseUrl: input.wsBaseUrl,
        ...(input.admission === undefined ? {} : { admission: input.admission }),
      }),
    };
    // The registry checks again under its lease; this early check keeps a refused code unspent.
    if (input.expectedEnvironmentId === undefined) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry.assertKnownAddress({ ...route, profile: Option.some(route.profile) });
    }
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    // An outdated server is still saved so it can be updated from this client.
    if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
      return yield* compatibilityError;
    }
    return route;
  },
);

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const route = yield* prepareBearerRoute({
    descriptor,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    expectedEnvironmentId: input.expectedEnvironmentId,
  });
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));

  return new BearerConnectionRegistration({
    ...route,
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
});

const TAILSCALE_HOST_SUFFIX = ".ts.net";
const T3_DEFAULT_PORT = 3773;
const TAILNET_PROBE_TIMEOUT_MS = 4_000;

/**
 * Where a typed machine name, MagicDNS name, or tailnet IP may answer, most likely first. The
 * direct address comes first because only it carries tailnet trust; `tailscale serve`'s HTTPS
 * name is tried after, for a server that only listens there.
 */
export function tailnetCandidateBaseUrls(address: string): ReadonlyArray<string> {
  const trimmed = address.trim().replace(/\/+$/, "");
  if (trimmed === "") return [];
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      return [normalizeHttpBaseUrl(trimmed)];
    } catch {
      return [];
    }
  }
  if (!URL.canParse(`http://${trimmed}`)) return [];
  const url = new URL(`http://${trimmed}`);
  const host = url.hostname;
  // Read from what was typed: `URL` drops `:80` as http's default.
  const port = /^(?:\[[^\]]*\]|[^:/]*):(\d+)(?:\/|$)/.exec(trimmed)?.[1];
  const tailscaleName = host.endsWith(TAILSCALE_HOST_SUFFIX);
  if (port !== undefined) {
    return [tailscaleName && port === "443" ? `https://${host}/` : `http://${host}:${port}/`];
  }
  return [`http://${host}:${T3_DEFAULT_PORT}/`, `https://${host}/`];
}

const probeTailnetAddress = Effect.fn("clientRuntime.connection.onboarding.probeTailnetAddress")(
  function* (address: string) {
    const candidates = tailnetCandidateBaseUrls(address);
    if (candidates.length === 0) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Enter a machine name or address.",
      });
    }
    for (const httpBaseUrl of candidates) {
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl,
        timeoutMs: TAILNET_PROBE_TIMEOUT_MS,
      }).pipe(Effect.option);
      if (Option.isSome(descriptor)) {
        return { httpBaseUrl, descriptor: descriptor.value };
      }
    }
    return yield* new ConnectionTransientError({
      reason: "network",
      detail: `Couldn't reach ${address.trim()}. Check that Tailscale is on and T3 Code is running there.`,
      hop: "server",
      via: "direct",
    });
  },
);

function mapTailnetSessionError(label: string) {
  return (error: RemoteEnvironmentAuthError): ConnectionAttemptError => {
    if (error._tag === "EnvironmentOperationForbiddenError") {
      return new ConnectionBlockedError({
        reason: "permission",
        detail:
          error.reason === "tailnet_trust_disabled"
            ? `Turn on "Trust my Tailscale devices" on ${label}, or enter a pairing code.`
            : `${label} doesn't recognize this device as yours on Tailscale. Enter a pairing code.`,
        traceId: error.traceId,
        hop: "server",
        via: "direct",
      });
    }
    if (error._tag === "EnvironmentInternalError" && error.reason === "tailnet_trust_unavailable") {
      return new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: `Tailscale on ${label} couldn't answer just now. Try again in a moment.`,
        traceId: error.traceId,
        hop: "server",
        via: "direct",
      });
    }
    if (error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" && error.status === 404) {
      return new ConnectionBlockedError({
        reason: "unsupported",
        detail: `${label} needs an update to connect without a code. Enter a pairing code.`,
        hop: "server",
        via: "direct",
      });
    }
    return mapRemoteEnvironmentError(error);
  };
}

export const prepareTailnetRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareTailnetRegistration",
)(function* (input: TailnetConnectionInput) {
  const { httpBaseUrl, descriptor } = yield* probeTailnetAddress(input.address);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const route = yield* prepareBearerRoute({
    descriptor,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    expectedEnvironmentId: input.expectedEnvironmentId,
    admission: "tailnet-trust",
  });
  const access = yield* requestRemoteTailnetSession({
    httpBaseUrl,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapTailnetSessionError(descriptor.label)));
  return new BearerConnectionRegistration({
    ...route,
    credential: new BearerConnectionCredential({ token: access.access_token }),
  });
});

const saveBearerRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.saveBearerRegistration",
)(function* (
  registration: BearerConnectionRegistration,
  expectedEnvironmentId: EnvironmentId | undefined,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const knownAddressOnly = expectedEnvironmentId === undefined;
  if (!(yield* registry.register(registration, { knownAddressOnly }))) {
    return registration.target.environmentId;
  }
  yield* registry.setCompatibility(registration.target.environmentId, null);
  yield* registry
    .setEnabled(registration.target.environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return registration.target.environmentId;
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  return yield* saveBearerRegistration(registration, input.expectedEnvironmentId);
});

const registerTailnetConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerTailnetConnection",
)(function* (input: TailnetConnectionInput) {
  const registration = yield* prepareTailnetRegistration(input);
  return yield* saveBearerRegistration(registration, input.expectedEnvironmentId);
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) => candidate.target._tag === "BearerConnectionTarget",
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      // The credential is unchanged, and so is how it was obtained.
      ...(entry.profile.value.admission === undefined
        ? {}
        : { admission: entry.profile.value.admission }),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
    credential: new BearerConnectionCredential({ token: provisioned.bearerToken }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  if (
    input.expectedEnvironmentId !== undefined &&
    registration.target.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(registration.target.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  // Provisioning retains the delegated onboarding operation spans.
  return ConnectionOnboarding.of({
    registerPairing: Effect.fnUntraced(
      function* (input) {
        return yield* registerPairingConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    registerTailnet: Effect.fnUntraced(
      function* (input) {
        return yield* registerTailnetConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    registerSsh: Effect.fnUntraced(
      function* (input) {
        return yield* registerSshConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
    ),
    updateBearer: Effect.fnUntraced(
      function* (input) {
        return yield* updateBearerConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
    ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);

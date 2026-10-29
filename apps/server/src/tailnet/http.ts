import { AuthAccessReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { TailnetDiscovery } from "./TailnetDiscovery.ts";
import { TailnetTrust } from "./TailnetTrust.ts";

const appendNoStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "tailnet",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const trust = yield* TailnetTrust;
    const discovery = yield* TailnetDiscovery;

    // A request with a credential must hold access:read; only a credential-less one may fall back
    // to tailnet identity, so a bad token never gets in on the device's word.
    const authorize = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
        Effect.catchTags({
          ServerAuthMissingCredentialError: () =>
            trust.identify(request).pipe(
              Effect.as(null),
              Effect.catch(() => failEnvironmentAuthInvalid("missing_credential")),
            ),
        }),
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
          failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          ),
        ),
        Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
          failEnvironmentInternal("internal_error", error),
        ),
      );
      if (session !== null && !session.scopes.includes(AuthAccessReadScope)) {
        return yield* failEnvironmentScopeRequired(AuthAccessReadScope);
      }
    });

    return handlers.handle(
      "peers",
      Effect.fn("environment.tailnet.peers")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* authorize(yield* HttpServerRequest.HttpServerRequest);
        yield* appendNoStore;
        return yield* discovery.peers;
      }),
    );
  }),
);

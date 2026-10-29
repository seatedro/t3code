import { AuthAccessReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { TailnetDiscovery } from "./TailnetDiscovery.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "tailnet",
  Effect.fnUntraced(function* (handlers) {
    const discovery = yield* TailnetDiscovery;
    return handlers.handle(
      "peers",
      Effect.fn("environment.tailnet.peers")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthAccessReadScope);
        return yield* discovery.peers;
      }),
    );
  }),
);

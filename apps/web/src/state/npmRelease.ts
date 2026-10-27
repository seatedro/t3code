import { useAtomValue } from "@effect/atom-react";
import { CLI_RELEASE_CHECKSUMS_FILE, cliReleaseTagUrl } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

// Fork: the fork publishes no npm package. Servers update from its GitHub release, which is
// installable once the checksums the installer verifies against are uploaded.
export const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(cliReleaseTagUrl(version));
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      return (
        typeof body === "object" &&
        body !== null &&
        "assets" in body &&
        Array.isArray(body.assets) &&
        body.assets.some(
          (asset: unknown) =>
            typeof asset === "object" &&
            asset !== null &&
            "name" in asset &&
            asset.name === CLI_RELEASE_CHECKSUMS_FILE,
        )
      );
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("npm-release-published:none"),
);

export function useNpmReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? npmReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}

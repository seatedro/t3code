import type { PackUserConfig } from "vite-plus/pack";

/**
 * Fork: the app is called Flock. Upstream's source keeps saying "T3 Code"; builds
 * rename it here so the fork carries no string edits that conflict on rebase.
 */
export const FORK_APP_NAME = "Flock";

// Data, not display text: old user-data folder names and the CLI shim's ownership marker.
const UPSTREAM_NAME = /T3 Code(?: \((?:Beta|Nightly)\))?(?! \((?:Alpha|Dev)\))/g;
const PRESERVED_MARKER = "Written by T3 Code:";
const MARKER_PLACEHOLDER = "\u0000fork-brand-marker\u0000";

export function forkBrandText(text: string): string {
  if (!text.includes("T3 Code")) return text;
  return text
    .replaceAll(PRESERVED_MARKER, MARKER_PLACEHOLDER)
    .replace(UPSTREAM_NAME, FORK_APP_NAME)
    .replaceAll(MARKER_PLACEHOLDER, PRESERVED_MARKER);
}

/** Vite and `vp pack` plugin. `map: null` tells the bundler no lines moved. */
export function forkBrandPlugin() {
  return {
    name: "fork-brand",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (id.includes("/node_modules/") || !code.includes("T3 Code")) return null;
      return { code: forkBrandText(code), map: null };
    },
    transformIndexHtml: forkBrandText,
  };
}

export function withForkBrand(configs: ReadonlyArray<PackUserConfig>): PackUserConfig[] {
  return configs.map((config) => ({
    ...config,
    plugins: [config.plugins, forkBrandPlugin()],
  }));
}

const FORK_ICONS = {
  MacIconPng: "assets/flock/flock-macos-1024.png",
  LinuxIconPng: "assets/flock/flock-universal-1024.png",
  WindowsIconIco: "assets/flock/flock-windows.ico",
  WebFaviconIco: "assets/flock/flock-web-favicon.ico",
  WebFavicon16Png: "assets/flock/flock-web-favicon-16x16.png",
  WebFavicon32Png: "assets/flock/flock-web-favicon-32x32.png",
  WebAppleTouchIconPng: "assets/flock/flock-web-apple-touch-180.png",
};

/** Release builds (nightly and stable) use Flock's icon; development keeps upstream's. */
export function withForkIcons<Paths extends Record<string, string>>(paths: Paths): Paths {
  const overrides = Object.fromEntries(
    ["nightly", "production"].flatMap((channel) =>
      Object.entries(FORK_ICONS).map(([asset, path]) => [`${channel}${asset}`, path]),
    ),
  );
  for (const key of Object.keys(overrides)) {
    if (!(key in paths)) throw new Error(`Unknown brand asset ${key}; upstream renamed it.`);
  }
  return Object.assign({}, paths, overrides);
}

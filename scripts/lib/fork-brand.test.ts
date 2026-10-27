import { assert, describe, it } from "@effect/vitest";

import { forkBrandText, withForkIcons } from "./fork-brand.ts";

describe("forkBrandText", () => {
  it("renames display text but keeps names the app reads back as data", () => {
    assert.strictEqual(
      forkBrandText('<title>T3 Code (Beta)</title> "Restart T3 Code on this device."'),
      '<title>Flock</title> "Restart Flock on this device."',
    );
    assert.strictEqual(forkBrandText("T3 Code (Nightly)"), "Flock");
    assert.strictEqual(
      forkBrandText('legacy: "T3 Code (Alpha)", dev: "T3 Code (Dev)"'),
      'legacy: "T3 Code (Alpha)", dev: "T3 Code (Dev)"',
    );
    assert.strictEqual(
      forkBrandText('"Written by T3 Code: runs the desktop app\'s bundled t3 CLI."'),
      '"Written by T3 Code: runs the desktop app\'s bundled t3 CLI."',
    );
  });

  it("gives release builds Flock's icons and refuses asset names upstream no longer has", () => {
    const upstream = {
      nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
      productionMacIconPng: "assets/prod/black-macos-1024.png",
      developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
    };
    assert.throws(() => withForkIcons(upstream), /Unknown brand asset nightlyLinuxIconPng/);
  });
});

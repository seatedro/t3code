import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as JjFixture from "../testing/JjFixture.ts";
import {
  jjContractFixture,
  runVcsDriverContractSuite,
} from "../testing/VcsDriverContractHarness.ts";
import * as VcsDriver from "../VcsDriver.ts";
import * as VcsProcess from "../VcsProcess.ts";
import * as JjCli from "./JjCli.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";

const layerJj = JjVcsDriver.layerVcs.pipe(
  Layer.provideMerge(JjCli.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(JjFixture.layerIsolatedEnv),
  Layer.provideMerge(NodeServices.layer),
);

const HOSTILE_TEMPLATE_ALIASES = `[template-aliases]
'name' = '"evil"'
'root' = '"evil"'
'json(x)' = '"evil"'
'concat(x)' = '"evil"'
`;

const makeRepoWithWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-driver-" });
  const main = path.join(parent, "main");
  const ws = path.join(parent, "ws1");
  yield* fileSystem.makeDirectory(main);
  yield* JjFixture.createColocatedRepo(main);
  yield* JjFixture.addWorkspace(main, "ws1", ws);
  return { parent, main, ws };
});

describe.skipIf(!JjFixture.jjAvailable)("JjVcsDriver", () => {
  runVcsDriverContractSuite({
    name: "Jujutsu",
    kind: "jj",
    layer: layerJj,
    fixture: jjContractFixture,
  });

  it.live("detects a secondary workspace as its own root sharing the main repo store", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const { main, ws } = yield* makeRepoWithWorkspace;

      const identity = yield* driver.detectRepository(path.join(ws));

      assert.equal(identity?.kind, "jj");
      assert.equal(identity?.rootPath, ws);
      assert.equal(identity?.metadataPath, path.join(main, ".jj", "repo"));
    }).pipe(Effect.provide(layerJj)),
  );

  it.live("reads each workspace's name, shielded from hostile template-aliases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { main, ws } = yield* makeRepoWithWorkspace;
      // The isolated config belongs to this test's layer, so it needs no restore.
      yield* fileSystem.writeFileString(process.env.JJ_CONFIG ?? "", HOSTILE_TEMPLATE_ALIASES);

      assert.equal(yield* JjVcsDriver.readCurrentWorkspaceName(main), "default");
      assert.equal(yield* JjVcsDriver.readCurrentWorkspaceName(ws), "ws1");
    }).pipe(Effect.provide(layerJj)),
  );

  it.live("treats an independent Git repository nested in a jj repo as not jj", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriver.VcsDriver;
      const { main } = yield* makeRepoWithWorkspace;
      const nested = path.join(main, "vendor", "lib");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      yield* JjFixture.runGit(nested, ["init", "-q"]);

      assert.equal(yield* driver.detectRepository(nested), null);
      assert.equal((yield* driver.detectRepository(path.join(main, "vendor")))?.rootPath, main);
    }).pipe(Effect.provide(layerJj)),
  );

  it.live("refuses Git-backed reads and reports unsupported in a non-colocated repo", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* VcsDriver.VcsDriver;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-driver-" });
      yield* JjFixture.createNonColocatedRepo(cwd);

      assert.equal((yield* driver.detectRepository(cwd))?.kind, "jj");
      const error = yield* driver.listWorkspaceFiles(cwd).pipe(Effect.flip);
      assert.equal(error._tag, "VcsUnsupportedOperationError");
      assert.equal((yield* JjVcsDriver.inspectSupport(cwd))?.code, "unsupported");
    }).pipe(Effect.provide(layerJj)),
  );

  it.live("reports a colocated workspace as supported and refuses to initialize", () =>
    Effect.gen(function* () {
      const driver = yield* VcsDriver.VcsDriver;
      const { main, ws } = yield* makeRepoWithWorkspace;

      assert.equal(yield* JjVcsDriver.inspectSupport(main), null);
      assert.equal(yield* JjVcsDriver.inspectSupport(ws), null);
      const error = yield* driver.initRepository({ cwd: main, kind: "jj" }).pipe(Effect.flip);
      assert.equal(error._tag, "VcsUnsupportedOperationError");
    }).pipe(Effect.provide(layerJj)),
  );
});

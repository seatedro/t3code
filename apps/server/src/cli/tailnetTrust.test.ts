// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const listedSubjects = (baseDir: string) =>
  runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]).pipe(
    Effect.andThen(TestConsole.logLines),
    Effect.map((lines) => {
      const sessions = JSON.parse(String(lines.at(-1))) as ReadonlyArray<{ subject: string }>;
      return sessions.map((session) => session.subject).toSorted();
    }),
  );

it.effect("turning trust off signs its devices out in the database, server or not", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-tailnet-cli-"));
    const tailnetSubject = "tailnet-device:nPhone:user%3A1%3Aowner%40github";
    for (const subject of [tailnetSubject, "cli-issued-session"]) {
      yield* runCli(["auth", "session", "issue", "--base-dir", baseDir, "--subject", subject]);
    }
    assert.deepEqual(yield* listedSubjects(baseDir), ["cli-issued-session", tailnetSubject]);

    yield* runCli(["auth", "tailnet-trust", "off", "--base-dir", baseDir]);

    assert.deepEqual(yield* listedSubjects(baseDir), ["cli-issued-session"]);
    const settings = JSON.parse(
      NodeFS.readFileSync(NodePath.join(baseDir, "userdata", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(settings.tailnetTrustEnabled, false);
  }),
);

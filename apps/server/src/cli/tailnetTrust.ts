import { readTailscaleTailnet } from "@t3tools/tailscale";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import { baseDirFlag } from "./config.ts";
import { readSettingsObject, resolveCliServerPaths, updateSettingsFile } from "./settingsFile.ts";

const tailnetTrustOnCommand = Command.make("on", {
  baseDir: baseDirFlag,
  login: Flag.String("login").pipe(
    Flag.withDescription(
      "Tailscale login whose devices to trust, such as you@github. Needed when this machine is tagged.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Let your Tailscale devices connect over the tailnet without a pairing code.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { settingsPath } = yield* resolveCliServerPaths(flags.baseDir);
      const login = Option.map(flags.login, (value) => value.trim());
      yield* updateSettingsFile(settingsPath, (settings) => ({
        ...settings,
        tailnetTrustEnabled: true,
        ...(Option.isSome(login) ? { tailnetTrustLogin: login.value } : {}),
      }));
      yield* Console.log(`Tailnet trust is on in ${settingsPath}.\n`);
    }),
  ),
);

const tailnetTrustOffCommand = Command.make("off", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Require a pairing code again and sign out devices let in this way."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { settingsPath } = yield* resolveCliServerPaths(flags.baseDir);
      yield* updateSettingsFile(settingsPath, (settings) => ({
        ...settings,
        tailnetTrustEnabled: false,
      }));
      yield* Console.log(`Tailnet trust is off in ${settingsPath}.\n`);
    }),
  ),
);

const tailnetTrustStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show whether tailnet trust is on and whose devices it trusts."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const { settingsPath } = yield* resolveCliServerPaths(flags.baseDir);
      const { settings } = yield* readSettingsObject(settingsPath);
      const enabled = settings.tailnetTrustEnabled === true;
      const login =
        typeof settings.tailnetTrustLogin === "string" ? settings.tailnetTrustLogin.trim() : "";
      const tailnet = yield* readTailscaleTailnet.pipe(Effect.orElseSucceed(() => null));
      const self = tailnet?.running === true ? tailnet.self : null;

      yield* Console.log(`Tailnet trust: ${enabled ? "on" : "off"}.\n`);
      if (login.length > 0) {
        yield* Console.log(`Configured login: ${login}.\n`);
      }
      if (self === null) {
        yield* Console.log("Tailscale: not running.\n");
      } else if (self.tagged) {
        yield* Console.log(
          login.length > 0
            ? `Tailscale: this machine is tagged, so trust covers devices of ${login}.\n`
            : "Tailscale: this machine is tagged and no login is set, so trust covers no device. Set one with `t3 auth tailnet-trust on --login <login>`.\n",
        );
      } else {
        yield* Console.log(
          `Tailscale: signed in as ${self.loginName ?? "an unknown login"}, so trust covers devices of that login.\n`,
        );
        if (login.length > 0) {
          yield* Console.log("The configured login only applies when this machine is tagged.\n");
        }
      }
    }),
  ),
);

export const tailnetTrustCommand = Command.make("tailnet-trust").pipe(
  Command.withDescription("Let devices on your Tailscale account connect without a pairing code."),
  Command.withSubcommands([
    tailnetTrustOnCommand,
    tailnetTrustOffCommand,
    tailnetTrustStatusCommand,
  ]),
);

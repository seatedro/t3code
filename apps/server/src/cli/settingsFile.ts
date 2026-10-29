import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";

const SparseSettings = Schema.Record(Schema.String, Schema.Unknown);
type SparseSettings = typeof SparseSettings.Type;
const decodeSettingsJson = Schema.decodeUnknownEffect(fromLenientJson(SparseSettings));
const encodeSettingsJson = Schema.encodeEffect(fromJsonStringPretty(SparseSettings));

export class SettingsFileUnreadableError extends Schema.TaggedError<SettingsFileUnreadableError>()(
  "SettingsFileUnreadableError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.settingsPath}. Fix its permissions, then run this again.`;
  }
}

export class SettingsFileMalformedError extends Schema.TaggedError<SettingsFileMalformedError>()(
  "SettingsFileMalformedError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.settingsPath} is not a JSON object. Fix or remove it, then run this again.`;
  }
}

export class SettingsFileBusyError extends Schema.TaggedError<SettingsFileBusyError>()(
  "SettingsFileBusyError",
  { settingsPath: Schema.String, attempts: Schema.Number },
) {
  override get message(): string {
    return `${this.settingsPath} kept changing while writing (gave up after ${this.attempts} attempts). Try again.`;
  }
}

export class SettingsFileWriteError extends Schema.TaggedError<SettingsFileWriteError>()(
  "SettingsFileWriteError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.settingsPath}.`;
  }
}

const envT3Home = Config.String("T3CODE_HOME").pipe(Config.option);

/** The server paths for `--base-dir`, else T3CODE_HOME, else the default home. */
export const resolveCliServerPaths = Effect.fn(function* (explicitBaseDir: Option.Option<string>) {
  const envHome = Option.filter(yield* envT3Home, (value) => value.trim().length > 0);
  const configuredBaseDir = Option.orElse(explicitBaseDir, () => envHome);
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
  return yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
    baseDirIsExplicit: Option.isSome(configuredBaseDir),
  });
});

/** Propagate read errors to avoid overwriting unread settings with a sparse file. */
export const readSettingsObject = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(settingsPath)
    .pipe(Effect.mapError((cause) => new SettingsFileUnreadableError({ settingsPath, cause })));
  const empty: SparseSettings = {};
  if (!exists) return { raw: "", settings: empty };

  const raw = yield* fs
    .readFileString(settingsPath)
    .pipe(Effect.mapError((cause) => new SettingsFileUnreadableError({ settingsPath, cause })));
  if (raw.trim().length === 0) return { raw, settings: empty };

  const settings = yield* decodeSettingsJson(raw).pipe(
    Effect.mapError((cause) => new SettingsFileMalformedError({ settingsPath, cause })),
  );
  return { raw, settings };
});

/** The server's in-process semaphore cannot serialize writes from this process. */
const CONCURRENT_WRITE_ATTEMPTS = 5;

/**
 * Rewrites settings.json sparsely, keeping keys this build does not know. The running server
 * watches the file, so it picks the change up without a restart.
 */
export const updateSettingsFile = Effect.fn(function* (
  settingsPath: string,
  update: (settings: SparseSettings) => SparseSettings,
) {
  const fs = yield* FileSystem.FileSystem;

  for (let attempt = 1; ; attempt++) {
    const { raw, settings } = yield* readSettingsObject(settingsPath);
    const contents = yield* encodeSettingsJson(update(settings));
    const current = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
    if (current !== raw) {
      if (attempt >= CONCURRENT_WRITE_ATTEMPTS) {
        return yield* new SettingsFileBusyError({
          settingsPath,
          attempts: CONCURRENT_WRITE_ATTEMPTS,
        });
      }
      continue;
    }

    yield* writeFileStringAtomically({ filePath: settingsPath, contents: `${contents}\n` }).pipe(
      Effect.mapError((cause) => new SettingsFileWriteError({ settingsPath, cause })),
    );
    return;
  }
});

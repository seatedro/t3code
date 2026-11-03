import type {
  SemanticDiffFile,
  SemanticDiffFileStatus,
  SemanticDiffOmittedFile,
} from "@t3tools/contracts";

import type { GitObjectRead } from "../vcs/GitObjectBatch.ts";
import type { DiffyFileInput } from "./Diffy.ts";

/** A changed file as git counts it; `previousPath` marks a rename. */
export interface CountedFile {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly additions: number;
  readonly deletions: number;
}

// Diffy's semantic diff gives up past 1 MiB a side, and so does its highlighter.
export const SEMANTIC_DIFF_MAX_FILE_BYTES = 1_048_576;

const OMITTED_REASON = {
  too_large: "too_large",
  over_budget: "request_too_large",
  unreadable: "unreadable",
} as const satisfies Record<string, SemanticDiffOmittedFile["reason"]>;

/** Narrows `files` to the requested paths, matching either side of a rename. */
export function filterPaths<File extends CountedFile>(
  files: ReadonlyArray<File>,
  paths: ReadonlyArray<string> | undefined,
): ReadonlyArray<File> {
  if (paths === undefined) return files;
  const wanted = new Set(paths);
  return files.filter(
    (file) =>
      wanted.has(file.path) || (file.previousPath !== undefined && wanted.has(file.previousPath)),
  );
}

/**
 * Pairs each file with its two reads (before, after) into Diffy's inputs. Files that couldn't be
 * read are omitted with the reason; `counted` lines up with `inputs` for git's counts.
 */
export function planSemanticDiff(
  files: ReadonlyArray<CountedFile>,
  reads: ReadonlyArray<readonly [GitObjectRead, GitObjectRead]>,
) {
  const inputs: DiffyFileInput[] = [];
  const counted: CountedFile[] = [];
  const omitted: SemanticDiffOmittedFile[] = [];
  files.forEach((file, index) => {
    const [before, after] = reads[index]!;
    const status: SemanticDiffFileStatus =
      file.previousPath !== undefined
        ? "renamed"
        : before._tag === "missing"
          ? "added"
          : after._tag === "missing"
            ? "deleted"
            : "modified";
    const paths = {
      ...(status === "added" ? {} : { old_path: file.previousPath ?? file.path }),
      ...(status === "deleted" ? {} : { new_path: file.path }),
    };
    const unread = [before, after].find((read) => read._tag !== "read" && read._tag !== "missing");
    if (unread !== undefined || (before._tag === "missing" && after._tag === "missing")) {
      omitted.push({
        status,
        ...paths,
        additions: file.additions,
        deletions: file.deletions,
        reason: OMITTED_REASON[unread?._tag ?? "unreadable"],
      });
      return;
    }
    counted.push(file);
    inputs.push({
      status,
      ...paths,
      ...(before._tag === "read" ? { old: before.bytes } : {}),
      ...(after._tag === "read" ? { new: after.bytes } : {}),
    });
  });
  return { inputs, counted, omitted };
}

/** Git's counts on Diffy's files, so a file reads the same here as in its summary. */
export function withGitCounts(
  diffed: ReadonlyArray<SemanticDiffFile>,
  counted: ReadonlyArray<CountedFile>,
): ReadonlyArray<SemanticDiffFile> {
  return diffed.map((file, index) => ({
    ...file,
    additions: counted[index]!.additions,
    deletions: counted[index]!.deletions,
  }));
}

/** Diffy's input for one file's gap, from its two reads. */
export function gapFileInput(
  input: {
    readonly status: SemanticDiffFileStatus;
    readonly old_path?: string;
    readonly new_path?: string;
  },
  before: GitObjectRead | undefined,
  after: GitObjectRead | undefined,
): DiffyFileInput {
  return {
    status: input.status,
    ...(input.old_path === undefined ? {} : { old_path: input.old_path }),
    ...(input.new_path === undefined ? {} : { new_path: input.new_path }),
    ...(before?._tag === "read" ? { old: before.bytes } : {}),
    ...(after?._tag === "read" ? { new: after.bytes } : {}),
  };
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

// Base64 over the socket grows it by a third; a screenshot fits, a texture atlas doesn't.
export const SEMANTIC_DIFF_MAX_IMAGE_BYTES = 4 * 1_048_576;

/** The image type a path's extension names, or null for files shown as text. */
export function imageMimeType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** An image read as the wire carries it, or null when it wasn't read. */
export function imageResult(path: string, read: GitObjectRead | undefined) {
  const mime = imageMimeType(path);
  if (mime === null || read?._tag !== "read") return { image: null };
  return {
    image: {
      mime,
      base64: Buffer.from(read.bytes).toString("base64"),
      bytes: read.bytes.byteLength,
    },
  };
}

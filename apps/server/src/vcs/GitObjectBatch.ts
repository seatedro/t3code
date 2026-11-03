export type GitObjectRead =
  | { readonly _tag: "missing" }
  | { readonly _tag: "unreadable" }
  | { readonly _tag: "too_large"; readonly size: number }
  | { readonly _tag: "over_budget"; readonly size: number }
  | { readonly _tag: "read"; readonly bytes: Uint8Array };

export interface GitObjectInfo {
  readonly oid: string;
  readonly size: number;
}

/** `git cat-file --batch-check` lines, one per requested revision, in order. */
export function parseBatchCheck(
  stdout: string,
  count: number,
): ReadonlyArray<GitObjectInfo | null> {
  const lines = stdout.split("\n");
  const objects: Array<GitObjectInfo | null> = [];
  for (let index = 0; index < count; index += 1) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(lines[index] ?? "");
    // `missing`, `ambiguous`, trees, and submodule commits all read as absent.
    objects.push(match ? { oid: match[1]!, size: Number(match[2]) } : null);
  }
  return objects;
}

/** Contents from `git cat-file --batch`, keyed by object id. */
export function parseBatch(output: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let position = 0;
  while (position < output.byteLength) {
    const headerEnd = output.indexOf(0x0a, position);
    if (headerEnd === -1) break;
    const header = decoder.decode(output.subarray(position, headerEnd));
    const match = /^([0-9a-f]+) \S+ (\d+)$/.exec(header);
    position = headerEnd + 1;
    if (!match) continue;
    const size = Number(match[2]);
    if (position + size > output.byteLength) break;
    contents.set(match[1]!, output.subarray(position, position + size));
    position += size + 1;
  }
  return contents;
}

/** Marks objects past either limit, in request order, so earlier files keep their contents. */
export function planObjectReads(
  objects: ReadonlyArray<GitObjectInfo | null>,
  limits: { readonly maxObjectBytes: number; readonly maxTotalBytes: number },
): ReadonlyArray<GitObjectRead | GitObjectInfo> {
  let remaining = limits.maxTotalBytes;
  return objects.map((object): GitObjectRead | GitObjectInfo => {
    if (object === null) return { _tag: "missing" };
    if (object.size > limits.maxObjectBytes) return { _tag: "too_large", size: object.size };
    if (object.size > remaining) return { _tag: "over_budget", size: object.size };
    remaining -= object.size;
    return object;
  });
}

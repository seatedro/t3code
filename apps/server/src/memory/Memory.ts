import type {
  MemoryBlock,
  MemoryEditResult,
  MemoryEntry,
  MemoryListInput,
  MemoryListResult,
  MemoryNode,
  MemoryOverview,
  MemoryPurgeResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An append-only agent memory after OptMem (github.com/VictorTaelin/OptMem): agents compress
 * aligned power-of-two blocks into one-line summaries, and `wake` reads recent memories verbatim
 * and older ones through coarser summaries. Pruning empties a memory's text but keeps its number.
 */

export const MemoryCommand = Schema.Literals(["wake", "note", "nap", "recall", "zoom", "forget"]);
export type MemoryCommand = typeof MemoryCommand.Type;

const WAKE_LINES = 96;
const ENTRY_BYTES = 280;
// Harnesses cut long tool output differently, so wake and recall stay under every cap.
const PART_BYTES = 20_000;
const PART_LINES = 500;
// Blocks this small are compressed from their memories; larger ones from their two halves.
const RAW_BLOCK_MAX = 16;
const SCAN_PAGE = 4_096;

/** A request the memory refuses; the reason tells the agent what to do instead. */
export class MemoryRefusal extends Schema.TaggedError<MemoryRefusal>()("MemoryRefusal", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class MemoryStorageError extends Schema.TaggedError<MemoryStorageError>()(
  "MemoryStorageError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read or write this environment's memory.";
  }
}

export class Memory extends Context.Service<
  Memory,
  {
    readonly run: (
      command: MemoryCommand,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<string, MemoryRefusal | MemoryStorageError>;
    readonly overview: Effect.Effect<MemoryOverview, MemoryStorageError>;
    readonly list: (
      input: MemoryListInput,
    ) => Effect.Effect<MemoryListResult, MemoryRefusal | MemoryStorageError>;
    readonly children: (
      block: MemoryBlock,
    ) => Effect.Effect<ReadonlyArray<MemoryNode>, MemoryRefusal | MemoryStorageError>;
    readonly prune: (
      ids: ReadonlyArray<number>,
    ) => Effect.Effect<MemoryEditResult, MemoryRefusal | MemoryStorageError>;
    readonly forget: (
      block: MemoryBlock,
    ) => Effect.Effect<MemoryEditResult, MemoryRefusal | MemoryStorageError>;
    readonly purge: Effect.Effect<MemoryPurgeResult, MemoryStorageError>;
  }
>()("t3/memory/Memory") {}

interface Block {
  readonly lo: number;
  readonly size: number;
}

interface MemoryRow {
  readonly id: number;
  readonly date: string;
  readonly text: string;
}

const refuse = (reason: string) => Effect.fail(new MemoryRefusal({ reason }));

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

const blockName = ({ lo, size }: Block) => `${lo}-${lo + size - 1}`;

const isPruned = (row: MemoryRow) => row.text === "";

const memoryLine = (row: MemoryRow) =>
  `#${row.id} ${row.date} ${isPruned(row) ? "(pruned)" : row.text}`;

const isBlock = ({ lo, size }: MemoryBlock) =>
  size >= 2 && (size & (size - 1)) === 0 && lo % size === 0;

const parseBlock = Effect.fn("Memory.parseBlock")(function* (id: string) {
  const match = /^(\d+)-(\d+)$/u.exec(id);
  if (match === null)
    return yield* refuse(`'${id}' is not a block id. Copy one as printed, like 16-31.`);
  const block = { lo: Number(match[1]), size: Number(match[2]) + 1 - Number(match[1]) };
  // Only aligned power-of-two ranges are blocks; otherwise 4-5 and 5-6 would name one summary.
  if (!isBlock(block))
    return yield* refuse(`${id} is not a block. Copy one as printed, like 16-31.`);
  return block satisfies Block;
});

const checkLine = Effect.fn("Memory.checkLine")(function* (input: string) {
  const text = input.trim();
  if (text.length === 0) return yield* refuse("Empty. A memory is one line of text.");
  if (/[\r\n]/u.test(text))
    return yield* refuse("A memory is one line: merge the lines, or note them separately.");
  const size = bytes(text);
  if (size > ENTRY_BYTES)
    return yield* refuse(
      `Too long: ${size} bytes, limit ${ENTRY_BYTES}. Accented characters cost 2 bytes. Compress it further.`,
    );
  return text;
});

/** Tiles [0, total) with aligned blocks, keeping one whole while it is at most `alpha` times its age. */
const tile = (total: number, alpha: number): Block[] => {
  let root = 1;
  while (root < total) root *= 2;
  const blocks: Block[] = [];
  const visit = (lo: number, size: number) => {
    if (lo >= total) return;
    if (size > 1 && (lo + size > total || size > alpha * (total - lo))) {
      visit(lo, size / 2);
      visit(lo + size / 2, size / 2);
    } else blocks.push({ lo, size });
  };
  visit(0, root);
  return blocks;
};

/** What wake prints: at most `budget` blocks, with recent memories the finest. */
const cover = (total: number, budget: number): Block[] => {
  if (total <= budget) return Array.from({ length: total }, (_, lo) => ({ lo, size: 1 }));
  let low = 0;
  let high = 1;
  for (let step = 0; step < 60; step += 1) {
    const alpha = (low + high) / 2;
    if (tile(total, alpha).length > budget) low = alpha;
    else high = alpha;
  }
  const blocks = tile(total, high);
  // Sizes jump by powers of two, so spend what the budget has left on the newest blocks.
  while (blocks.length < budget) {
    let index = blocks.length - 1;
    while (index >= 0 && blocks[index]!.size === 1) index -= 1;
    if (index < 0) break;
    const { lo, size } = blocks[index]!;
    blocks.splice(index, 1, { lo, size: size / 2 }, { lo: lo + size / 2, size: size / 2 });
  }
  return blocks;
};

const paginate = (lines: ReadonlyArray<string>) => {
  const parts: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const lineBytes = bytes(line) + 1;
    if (current.length > 0 && (current.length >= PART_LINES || size + lineBytes > PART_BYTES)) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += lineBytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new MemoryStorageError({ cause })));

  const memoryCount = stored(
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM flock_memory_log`.pipe(
      Effect.map((rows) => Number(rows[0]?.n ?? 0)),
    ),
  );

  const memories = (lo: number, hi: number) =>
    stored(
      sql<MemoryRow>`
        SELECT id, date, text FROM flock_memory_log WHERE id >= ${lo} AND id < ${hi} ORDER BY id
      `,
    );

  const summary = ({ lo, size }: Block) =>
    stored(
      sql<{ readonly text: string }>`
        SELECT text FROM flock_memory_tree WHERE size = ${size} AND lo = ${lo}
      `.pipe(Effect.map((rows) => rows[0]?.text)),
    );

  /** Blocks of the first `total` memories with no summary yet, smallest first, and how many. */
  const pending = (total: number) =>
    stored(
      sql<{ readonly size: number; readonly n: number }>`
        SELECT size, COUNT(*) AS n FROM flock_memory_tree GROUP BY size
      `,
    ).pipe(
      Effect.map((rows) => {
        const built = new Map(rows.map((row) => [Number(row.size), Number(row.n)]));
        let next: Block | undefined;
        let count = 0;
        for (let size = 2; size <= total; size *= 2) {
          const have = built.get(size) ?? 0;
          const missing = Math.max(0, Math.floor(total / size) - have);
          if (next === undefined && missing > 0) next = { lo: have * size, size };
          count += missing;
        }
        return { next, count };
      }),
    );

  const napPrompt = Effect.fn("Memory.napPrompt")(function* (block: Block, remaining: number) {
    const kept = (rows: ReadonlyArray<MemoryRow>) => {
      const lines = rows.filter((row) => !isPruned(row)).map((row) => `  ${memoryLine(row)}`);
      return lines.length > 0 ? lines : ["  (every memory here was pruned)"];
    };
    const body =
      block.size <= RAW_BLOCK_MAX
        ? kept(yield* memories(block.lo, block.lo + block.size))
        : yield* Effect.forEach(
            [
              { lo: block.lo, size: block.size / 2 },
              { lo: block.lo + block.size / 2, size: block.size / 2 },
            ],
            (half) =>
              summary(half).pipe(Effect.map((text) => `  #${blockName(half)} ${text ?? ""}`)),
          );
    return [
      `Compress memories #${blockName(block)} into one line of at most ${ENTRY_BYTES} bytes. Keep what has lasting effect, drop what does not, and invent nothing.`,
      "",
      ...body,
      ...(remaining > 0
        ? ["", `${counted(remaining, "compression", "compressions")} remain after this one.`]
        : []),
      `Run: memory nap ${blockName(block)} "<your line>"`,
    ].join("\n");
  });

  const nextNap = Effect.fn("Memory.nextNap")(function* (total: number) {
    const { next, count } = yield* pending(total);
    return next === undefined ? undefined : yield* napPrompt(next, count - 1);
  });

  const wake = Effect.fn("Memory.wake")(function* (args: ReadonlyArray<string>) {
    const now = yield* memoryCount;
    if (args.length > 2 || !args.every((arg) => /^\d+$/u.test(arg)))
      return yield* refuse("usage: memory wake [part [T]]");
    const part = args[0] === undefined ? 1 : Number(args[0]);
    const total = args[1] === undefined ? now : Number(args[1]);
    if (total > now)
      return yield* refuse(
        `T=${total}, but there are ${counted(now, "memory", "memories")}. Run: memory wake`,
      );
    if (total === 0)
      return 'No memories yet. Save the first with: memory note "<one line>"\nYou are awake.';
    const blocks = cover(total, WAKE_LINES);
    const firstSingle = blocks.find((block) => block.size === 1)?.lo ?? total;
    const singles = new Map(
      (yield* memories(firstSingle, total)).map((row) => [Number(row.id), row]),
    );
    const lines: string[] = [];
    for (const block of blocks) {
      if (block.size === 1) {
        const row = singles.get(block.lo);
        if (row !== undefined && !isPruned(row)) lines.push(memoryLine(row));
        continue;
      }
      const text = yield* summary(block);
      if (text === undefined) {
        const { count } = yield* pending(total);
        return [
          `Cannot wake yet: your memory needs #${blockName(block)}, which is not compressed.`,
          `Do the ${counted(count, "compression", "compressions")} below, then run memory wake again.`,
          "",
          (yield* nextNap(total)) ?? "",
        ].join("\n");
      }
      lines.push(`#${blockName(block)} ${text}`);
    }
    const parts = paginate(lines);
    if (part < 1 || part > parts.length)
      return yield* refuse(
        `No part ${part}: your memory has ${counted(parts.length, "part", "parts")}. Run: memory wake`,
      );
    const output = [
      ...(parts.length > 1
        ? [
            `Your memory, part ${part} of ${parts.length}, oldest first (${counted(total, "memory", "memories")}).`,
          ]
        : []),
      ...parts[part - 1]!,
    ];
    // The footer survives a harness cutting the head, so it says how to continue.
    if (part < parts.length)
      return [...output, `Not awake yet. Run: memory wake ${part + 1} ${total}`].join("\n");
    const nap = yield* nextNap(total);
    return [...output, "You are awake.", ...(nap === undefined ? [] : ["", nap])].join("\n");
  });

  const note = Effect.fn("Memory.note")(function* (args: ReadonlyArray<string>) {
    if (args.length !== 1)
      return yield* refuse(`usage: memory note "<one line, at most ${ENTRY_BYTES} bytes>"`);
    const text = yield* checkLine(args[0]!);
    const date = DateTime.formatIsoDateUtc(yield* DateTime.now);
    // One statement, so parallel sessions noting at once never share an id.
    const rows = yield* stored(
      sql<{ readonly id: number }>`
        INSERT INTO flock_memory_log (id, date, text)
        SELECT COALESCE(MAX(id) + 1, 0), ${date}, ${text} FROM flock_memory_log
        RETURNING id
      `,
    );
    const id = Number(rows[0]!.id);
    const nap = yield* nextNap(id + 1);
    return [`Saved as #${id}.`, ...(nap === undefined ? [] : ["", nap])].join("\n");
  });

  const nap = Effect.fn("Memory.nap")(function* (args: ReadonlyArray<string>) {
    if (args.length !== 0 && args.length !== 2)
      return yield* refuse('usage: memory nap <lo>-<hi> "<one line>"');
    const total = yield* memoryCount;
    const said: string[] = [];
    if (args.length === 2) {
      const block = yield* parseBlock(args[0]!);
      const { next } = yield* pending(total);
      if (next === undefined) return "Nothing left to compress.";
      if (next.lo !== block.lo || next.size !== block.size) {
        if ((yield* summary(block)) === undefined)
          return yield* refuse(
            `Wrong block: ${args[0]}. Blocks are compressed in order; the next is ${blockName(next)}. Run: memory nap`,
          );
        said.push(`${blockName(block)} is already saved.`);
      } else {
        const text = yield* checkLine(args[1]!);
        // Each level fills in order; a block forgotten or saved meanwhile is not written twice.
        const inserted = yield* stored(
          sql`
            INSERT INTO flock_memory_tree (size, lo, text)
            SELECT ${block.size}, ${block.lo}, ${text}
            WHERE (SELECT COUNT(*) FROM flock_memory_tree WHERE size = ${block.size}) = ${block.lo / block.size}
            ON CONFLICT DO NOTHING
            RETURNING lo
          `,
        );
        said.push(
          inserted.length > 0
            ? `${blockName(block)} saved.`
            : `${blockName(block)} was saved or forgotten meanwhile.`,
        );
      }
    }
    const prompt = yield* nextNap(total);
    if (prompt === undefined) return [...said, "Nothing left to compress."].join("\n");
    return [...said, ...(said.length > 0 ? [""] : []), prompt].join("\n");
  });

  const recall = Effect.fn("Memory.recall")(function* (args: ReadonlyArray<string>) {
    if (args.length !== 1) return yield* refuse("usage: memory recall <regex>");
    const pattern = yield* Effect.try({
      try: () => new RegExp(args[0]!, "i"),
      catch: () => new MemoryRefusal({ reason: `Not a valid regular expression: ${args[0]}` }),
    });
    // Keep only the newest matches that fit one part; a vague pattern matches everything.
    const kept: string[] = [];
    let keptBytes = 0;
    let hits = 0;
    let cursor = 0;
    while (true) {
      const page = yield* memories(cursor, cursor + SCAN_PAGE);
      for (const row of page) {
        const line = memoryLine(row);
        if (isPruned(row) || !pattern.test(line)) continue;
        hits += 1;
        kept.push(line);
        keptBytes += bytes(line) + 1;
        while (keptBytes > PART_BYTES) keptBytes -= bytes(kept.shift()!) + 1;
      }
      if (page.length < SCAN_PAGE) break;
      cursor += SCAN_PAGE;
    }
    if (hits === 0) return "No match.";
    const footer =
      kept.length < hits
        ? `Newest ${kept.length} of ${counted(hits, "match", "matches")}. Narrow the regex.`
        : `${counted(hits, "match", "matches")}.`;
    return [...kept, footer].join("\n");
  });

  const zoom = Effect.fn("Memory.zoom")(function* (args: ReadonlyArray<string>) {
    if (args.length !== 1) return yield* refuse("usage: memory zoom <lo>-<hi>");
    const block = yield* parseBlock(args[0]!);
    const total = yield* memoryCount;
    if (block.lo >= total)
      return yield* refuse(
        `#${args[0]} is beyond your memory: it holds ${counted(total, "memory", "memories")}. Run: memory wake`,
      );
    const halves = [
      { lo: block.lo, size: block.size / 2 },
      { lo: block.lo + block.size / 2, size: block.size / 2 },
    ].filter((half) => half.lo < total);
    const lines = yield* Effect.forEach(halves, (half) =>
      half.size === 1
        ? memories(half.lo, half.lo + 1).pipe(Effect.map((rows) => rows.map(memoryLine).join("\n")))
        : summary(half).pipe(
            Effect.map((text) => `#${blockName(half)} ${text ?? "not compressed yet"}`),
          ),
    );
    return lines.join("\n");
  });

  /** Drops a summary with every later one on its level and everything built on it; the log stays. */
  const dropFrom = Effect.fn("Memory.dropFrom")(function* (block: Block, total: number) {
    const removed: Block[] = [];
    for (let size = block.size; size <= total; size *= 2) {
      const from = Math.floor(block.lo / size) * size;
      const rows = yield* sql<{ readonly lo: number }>`
          DELETE FROM flock_memory_tree WHERE size = ${size} AND lo >= ${from} RETURNING lo
        `;
      removed.push(
        ...rows.map((row) => ({ lo: Number(row.lo), size })).sort((a, b) => a.lo - b.lo),
      );
    }
    return removed;
  });

  const forget = Effect.fn("Memory.forget")(function* (args: ReadonlyArray<string>) {
    if (args.length !== 1) return yield* refuse("usage: memory forget <lo>-<hi>");
    const block = yield* parseBlock(args[0]!);
    const total = yield* memoryCount;
    const gone = yield* stored(sql.withTransaction(dropFrom(block, total)));
    if (gone.length === 0) return yield* refuse(`No summary at ${args[0]}.`);
    return `Forgot ${counted(gone.length, "summary", "summaries")}, from ${blockName(gone[0]!)} up. Run: memory nap`;
  });

  const nodeOf = Effect.fn("Memory.nodeOf")(function* (block: Block) {
    if (block.size === 1) {
      const row = (yield* memories(block.lo, block.lo + 1))[0];
      return {
        ...block,
        kind: row === undefined || isPruned(row) ? "pruned" : "memory",
        text: row === undefined || isPruned(row) ? null : row.text,
        ...(row === undefined ? {} : { date: row.date }),
      } satisfies MemoryNode;
    }
    const text = yield* summary(block);
    return {
      ...block,
      kind: text === undefined ? "pending" : "summary",
      text: text ?? null,
    } satisfies MemoryNode;
  });

  const overview = Effect.gen(function* () {
    const total = yield* memoryCount;
    const [counts] = yield* stored(
      sql<{ readonly pruned: number; readonly summaries: number; readonly since: string | null }>`
        SELECT
          (SELECT COUNT(*) FROM flock_memory_log WHERE text = '') AS pruned,
          (SELECT COUNT(*) FROM flock_memory_tree) AS summaries,
          (SELECT date FROM flock_memory_log ORDER BY id LIMIT 1) AS since
      `,
    );
    // The largest aligned blocks that tile [0, total): one per set bit of the count.
    const roots: Block[] = [];
    for (let size = 2 ** Math.floor(Math.log2(Math.max(total, 1))), lo = 0; size >= 1; size /= 2) {
      if (lo + size <= total) {
        roots.push({ lo, size });
        lo += size;
      }
    }
    return {
      memories: total,
      pruned: Number(counts?.pruned ?? 0),
      summaries: Number(counts?.summaries ?? 0),
      pendingCompressions: (yield* pending(total)).count,
      since: counts?.since ?? null,
      roots: total === 0 ? [] : yield* Effect.forEach(roots, nodeOf),
      wake: yield* wake([]).pipe(
        Effect.catchTags({ MemoryRefusal: (refusal) => Effect.succeed(refusal.reason) }),
      ),
    } satisfies MemoryOverview;
  }).pipe(Effect.withSpan("Memory.overview"));

  const list = Effect.fn("Memory.list")(function* (input: MemoryListInput) {
    const limit = input.limit ?? 50;
    const pattern =
      input.query === undefined || input.query.trim() === ""
        ? null
        : yield* Effect.try({
            try: () => new RegExp(input.query!, "i"),
            catch: () => new MemoryRefusal({ reason: "Not a valid regular expression." }),
          });
    const entries: MemoryEntry[] = [];
    let cursor = input.before ?? (yield* memoryCount);
    while (cursor > 0 && entries.length < limit) {
      const from = Math.max(0, cursor - (pattern === null ? limit - entries.length : SCAN_PAGE));
      const page = (yield* memories(from, cursor)).toReversed();
      for (const row of page) {
        cursor = Number(row.id);
        if (pattern !== null && (isPruned(row) || !pattern.test(memoryLine(row)))) continue;
        entries.push({ id: Number(row.id), date: row.date, text: isPruned(row) ? null : row.text });
        if (entries.length === limit) break;
      }
      if (page.length === 0) cursor = from;
    }
    return { entries, nextBefore: cursor > 0 ? cursor : null } satisfies MemoryListResult;
  });

  const children = Effect.fn("Memory.children")(function* (block: MemoryBlock) {
    if (!isBlock(block)) return yield* refuse("Not a block of memories.");
    const total = yield* memoryCount;
    const halves = [
      { lo: block.lo, size: block.size / 2 },
      { lo: block.lo + block.size / 2, size: block.size / 2 },
    ].filter((half) => half.lo < total);
    return yield* Effect.forEach(halves, nodeOf);
  });

  const prune = Effect.fn("Memory.prune")(function* (ids: ReadonlyArray<number>) {
    const total = yield* memoryCount;
    const valid = [...new Set(ids)].filter((id) => id < total);
    if (valid.length === 0) return yield* refuse("None of those memories exist.");
    // Every summary that includes a pruned memory is rebuilt, so the pruned text leaves the tree.
    return yield* stored(
      sql.withTransaction(
        Effect.gen(function* () {
          const dropped = yield* dropFrom({ lo: Math.min(...valid), size: 2 }, total);
          const pruned = yield* sql<{ readonly id: number }>`
            UPDATE flock_memory_log SET text = '' WHERE ${sql.in("id", valid)} AND text <> '' RETURNING id
          `;
          return { pruned: pruned.length, summariesDropped: dropped.length };
        }),
      ),
    );
  });

  const forgetBlock = Effect.fn("Memory.forgetBlock")(function* (block: MemoryBlock) {
    if (!isBlock(block)) return yield* refuse("Not a block of memories.");
    const total = yield* memoryCount;
    const dropped = yield* stored(sql.withTransaction(dropFrom(block, total)));
    if (dropped.length === 0) return yield* refuse("That summary is not written yet.");
    return { pruned: 0, summariesDropped: dropped.length } satisfies MemoryEditResult;
  });

  const purge = stored(
    sql.withTransaction(
      Effect.gen(function* () {
        const memoriesGone = yield* sql`DELETE FROM flock_memory_log RETURNING id`;
        const summariesGone = yield* sql`DELETE FROM flock_memory_tree RETURNING lo`;
        return { memories: memoriesGone.length, summaries: summariesGone.length };
      }),
    ),
  ).pipe(Effect.withSpan("Memory.purge"));

  const commands = { wake, note, nap, recall, zoom, forget };

  return Memory.of({
    run: Effect.fn("Memory.run")(function* (command, args) {
      yield* Effect.annotateCurrentSpan({ "memory.command": command });
      return yield* commands[command](args);
    }),
    overview,
    list,
    children,
    prune,
    forget: forgetBlock,
    purge,
  });
});

export const layer = Layer.effect(Memory, make);

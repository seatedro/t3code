import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Memory from "./Memory.ts";

const memoryLayer = Memory.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
);

const run = Effect.fn(function* (command: Memory.MemoryCommand, ...args: ReadonlyArray<string>) {
  const memory = yield* Memory.Memory;
  return yield* memory.run(command, args);
});

const nextNapBlock = (output: string) => /Run: memory nap (\d+-\d+)/u.exec(output)?.[1];

/** Answers every pending compression the way an agent would, joining the lines it is shown. */
const napAll = Effect.fn(function* () {
  let prompt = yield* run("nap");
  let block = nextNapBlock(prompt);
  while (block !== undefined) {
    const lines = prompt.split("\n").filter((line) => line.startsWith("  #"));
    prompt = yield* run("nap", block, `S(${lines.length} from ${block})`);
    block = nextNapBlock(prompt);
  }
  return prompt;
});

it.effect("notes land in order and wake reads them back", () =>
  Effect.gen(function* () {
    expect(yield* run("wake")).toBe(
      'No memories yet. Save the first with: memory note "<one line>"\nYou are awake.',
    );
    expect(yield* run("note", "  prefers small PRs  ")).toBe("Saved as #0.");

    const second = yield* run("note", "works from pulsar");

    expect(second).toContain("Saved as #1.");
    expect(nextNapBlock(second)).toBe("0-1");
    expect(yield* run("wake")).toBe(
      [
        "#0 1970-01-01 prefers small PRs",
        "#1 1970-01-01 works from pulsar",
        "You are awake.",
        "",
        "Compress memories #0-1 into one line of at most 280 bytes. Keep what has lasting effect, drop what does not, and invent nothing.",
        "",
        "  #0 1970-01-01 prefers small PRs",
        "  #1 1970-01-01 works from pulsar",
        'Run: memory nap 0-1 "<your line>"',
      ].join("\n"),
    );
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("a long memory wakes through summaries once they are compressed", () =>
  Effect.gen(function* () {
    for (let index = 0; index < 200; index += 1) yield* run("note", `memory ${index}`);

    const blocked = yield* run("wake");
    expect(blocked).toMatch(/^Cannot wake yet: your memory needs #\d+-\d+/u);
    expect(nextNapBlock(blocked)).toBe("0-1");

    expect(yield* napAll()).toMatch(/saved\.\nNothing left to compress\.$/u);
    const lines = (yield* run("wake")).split("\n");

    expect(lines.at(-1)).toBe("You are awake.");
    expect(lines.length).toBeLessThanOrEqual(97);
    expect(lines[0]).toMatch(/^#0-\d+ S\(/u);
    expect(lines.at(-2)).toBe("#199 1970-01-01 memory 199");
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("compressions go in order, and a forgotten one comes back to be redone", () =>
  Effect.gen(function* () {
    for (let index = 0; index < 4; index += 1) yield* run("note", `fact ${index}`);

    const wrong = yield* Effect.flip(run("nap", "2-3", "too early"));
    expect(wrong.message).toBe(
      "Wrong block: 2-3. Blocks are compressed in order; the next is 0-1. Run: memory nap",
    );
    expect((yield* Effect.flip(run("nap", "1-2", "x"))).message).toBe(
      "1-2 is not a block. Copy one as printed, like 16-31.",
    );
    yield* napAll();
    expect(yield* run("zoom", "0-3")).toBe("#0-1 S(2 from 0-1)\n#2-3 S(2 from 2-3)");

    expect(yield* run("forget", "2-3")).toBe("Forgot 2 summaries, from 2-3 up. Run: memory nap");

    expect(yield* run("zoom", "0-3")).toBe("#0-1 S(2 from 0-1)\n#2-3 not compressed yet");
    expect(nextNapBlock(yield* run("nap"))).toBe("2-3");
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("recall searches every memory and refuses what is not a memory", () =>
  Effect.gen(function* () {
    yield* run("note", "Deploys go through fork-release");
    yield* run("note", "Rebase runs at 14:00 UTC");

    expect(yield* run("recall", "deploy|rebase")).toBe(
      [
        "#0 1970-01-01 Deploys go through fork-release",
        "#1 1970-01-01 Rebase runs at 14:00 UTC",
        "2 matches.",
      ].join("\n"),
    );
    expect(yield* run("recall", "nothing")).toBe("No match.");
    expect((yield* Effect.flip(run("note", "two\nlines"))).message).toBe(
      "A memory is one line: merge the lines, or note them separately.",
    );
    expect((yield* Effect.flip(run("note", "x".repeat(281)))).message).toMatch(
      /^Too long: 281 bytes, limit 280\./u,
    );
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("fork migrations keep their own history apart from upstream's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const fork = yield* sql<{ readonly name: string }>`SELECT name FROM flock_migrations`;
    const upstream = yield* sql<{ readonly name: string }>`
      SELECT name FROM effect_sql_migrations WHERE name = 'Memory'
    `;

    expect(fork.map((row) => row.name)).toEqual(["Memory"]);
    expect(upstream).toEqual([]);
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("the viewer pages memories newest first and searches them", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.Memory;
    for (let index = 0; index < 5; index += 1) yield* run("note", `fact ${index}`);

    const first = yield* memory.list({ limit: 2 });
    const second = yield* memory.list({ limit: 2, before: first.nextBefore! });
    const last = yield* memory.list({ limit: 2, before: second.nextBefore! });

    expect(first.entries.map((entry) => entry.id)).toEqual([4, 3]);
    expect(second.entries.map((entry) => entry.id)).toEqual([2, 1]);
    expect(last).toEqual({
      entries: [{ id: 0, date: "1970-01-01", text: "fact 0" }],
      nextBefore: null,
    });
    expect((yield* memory.list({ query: "fact [13]" })).entries.map((entry) => entry.id)).toEqual([
      3, 1,
    ]);
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("the overview shows the tree's top blocks and what agents see", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.Memory;
    for (let index = 0; index < 6; index += 1) yield* run("note", `fact ${index}`);
    yield* napAll();

    const overview = yield* memory.overview;

    expect(overview).toMatchObject({
      memories: 6,
      pruned: 0,
      summaries: 4,
      pendingCompressions: 0,
    });
    expect(overview.roots).toEqual([
      { lo: 0, size: 4, kind: "summary", text: "S(4 from 0-3)" },
      { lo: 4, size: 2, kind: "summary", text: "S(2 from 4-5)" },
    ]);
    expect(overview.wake).toContain("You are awake.");
    expect(yield* memory.children({ lo: 0, size: 4 })).toEqual([
      { lo: 0, size: 2, kind: "summary", text: "S(2 from 0-1)" },
      { lo: 2, size: 2, kind: "summary", text: "S(2 from 2-3)" },
    ]);
    expect(yield* memory.children({ lo: 4, size: 2 })).toEqual([
      { lo: 4, size: 1, kind: "memory", text: "fact 4", date: "1970-01-01" },
      { lo: 5, size: 1, kind: "memory", text: "fact 5", date: "1970-01-01" },
    ]);
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("pruning removes the text everywhere agents read and rebuilds what summarized it", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.Memory;
    for (let index = 0; index < 4; index += 1) yield* run("note", `fact ${index}`);
    yield* run("note", "secret token abc");
    yield* run("note", "fact 5");
    yield* napAll();

    const result = yield* memory.prune([4]);

    expect(result).toEqual({ pruned: 1, summariesDropped: 1 });
    expect((yield* memory.list({ limit: 2 })).entries[1]).toEqual({
      id: 4,
      date: "1970-01-01",
      text: null,
    });
    expect(yield* run("recall", "secret")).toBe("No match.");
    const prompt = yield* run("nap");
    expect(nextNapBlock(prompt)).toBe("4-5");
    expect(prompt).not.toContain("secret");
    expect(prompt).toContain("#5 1970-01-01 fact 5");
    expect(yield* memory.prune([4])).toEqual({ pruned: 0, summariesDropped: 0 });
  }).pipe(Effect.provide(memoryLayer)),
);

it.effect("forget drops a summary from the viewer, and purge empties the memory", () =>
  Effect.gen(function* () {
    const memory = yield* Memory.Memory;
    for (let index = 0; index < 4; index += 1) yield* run("note", `fact ${index}`);
    yield* napAll();

    expect(yield* memory.forget({ lo: 0, size: 2 })).toEqual({ pruned: 0, summariesDropped: 3 });
    expect((yield* Effect.flip(memory.forget({ lo: 0, size: 2 }))).message).toBe(
      "That summary is not written yet.",
    );
    expect(yield* memory.purge).toEqual({ memories: 4, summaries: 0 });
    expect(yield* memory.overview).toMatchObject({ memories: 0, summaries: 0, roots: [] });
  }).pipe(Effect.provide(memoryLayer)),
);

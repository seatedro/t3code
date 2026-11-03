import { describe, expect, it } from "vite-plus/test";

import { fuseModifiedLine } from "./diffFuse.ts";

// Rows as Diffy 0.1.0 produced them for a Rust file.
const width = {
  old: {
    line: 2,
    text: "let x = alt.len() as u16;",
    changes: [{ start: 12, end: 15, intensity: "novel" as const }],
  },
  new: {
    line: 2,
    text: "let x = alt.width() as u16;",
    changes: [{ start: 12, end: 17, intensity: "novel" as const }],
  },
};

describe("fuseModifiedLine", () => {
  it.each([
    {
      name: "strikes a replaced word before its replacement",
      row: width,
      segments: [
        { kind: "same", text: "let x = alt.", offset: 0 },
        { kind: "removed", text: "len", offset: 12 },
        { kind: "added", text: "width", offset: 12 },
        { kind: "same", text: "() as u16;", offset: 17 },
      ],
    },
    {
      name: "folds the whitespace Diffy leaves beside an insertion into it",
      row: {
        old: { line: 3, text: "render(offset, a);" },
        new: {
          line: 3,
          text: "render(&mut offset, a);",
          changes: [{ start: 7, end: 11, intensity: "novel" as const }],
        },
      },
      segments: [
        { kind: "same", text: "render(", offset: 0 },
        { kind: "added", text: "&mut ", offset: 7 },
        { kind: "same", text: "offset, a);", offset: 12 },
      ],
    },
    {
      name: "keeps unchanged context spans as unchanged text",
      row: {
        old: {
          line: 1,
          text: "a(b)",
          changes: [{ start: 0, end: 4, intensity: "unchanged_context" as const }],
        },
        new: {
          line: 1,
          text: "a(b, c)",
          changes: [{ start: 3, end: 6, intensity: "novel_word" as const }],
        },
      },
      segments: [
        { kind: "same", text: "a(b", offset: 0 },
        { kind: "added", text: ", c", offset: 3 },
        { kind: "same", text: ")", offset: 6 },
      ],
    },
    {
      name: "gives up when the sides' unchanged text differs",
      row: {
        old: { line: 4, text: "call(one);" },
        new: { line: 4, text: "call(two);" },
      },
      segments: null,
    },
    {
      name: "gives up when less than half the new line survived",
      row: {
        old: {
          line: 1,
          text: "x = 1",
          changes: [{ start: 4, end: 5, intensity: "novel" as const }],
        },
        new: {
          line: 1,
          text: "x = compute(1)",
          changes: [{ start: 4, end: 14, intensity: "novel" as const }],
        },
      },
      segments: null,
    },
  ])("$name", ({ row, segments }) => {
    expect(fuseModifiedLine(row.old, row.new)).toEqual(segments);
  });
});

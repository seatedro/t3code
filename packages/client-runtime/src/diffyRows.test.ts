import type { SemanticDiffChangeSpan, SemanticDiffFile, SemanticDiffRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type DiffyRow, diffyHunkRows, mergePair, type MergePiece } from "./diffyRows.ts";

const span = (
  start: number,
  end: number,
  intensity: SemanticDiffChangeSpan["intensity"] = "novel",
): SemanticDiffChangeSpan => ({ start, end, intensity });

function render(old: string, next: string, pieces: ReadonlyArray<MergePiece>) {
  return pieces
    .map((piece) => {
      const text = (piece.side === "old" ? old : next).slice(piece.start, piece.end);
      return piece.side === "old" ? `[-${text}-]` : piece.changed ? `{+${text}+}` : text;
    })
    .join("");
}

const merged = (
  old: string,
  next: string,
  oldSpans: SemanticDiffChangeSpan[],
  newSpans: SemanticDiffChangeSpan[],
) => {
  const pieces = mergePair(old, next, oldSpans, newSpans);
  return pieces === null ? null : render(old, next, pieces);
};

// The cases of diffy's own merge.rs tests.
describe("mergePair", () => {
  it("puts removed pieces where they were", () => {
    expect(merged("    limit = 10;", "        limit = 20;", [span(12, 14)], [span(16, 18)])).toBe(
      "        limit = [-10-]{+20+};",
    );
    expect(merged("step(first, second);", "step(first, extra, second);", [], [span(12, 18)])).toBe(
      "step(first, {+extra,+} second);",
    );
    expect(merged("call(a, b)", "call(a)", [span(6, 7), span(8, 9)], [])).toBe("call(a[-, b-])");
  });

  it("puts removed pieces after a renamed token", () => {
    expect(
      merged(
        "this.before()",
        "this.onUpdate(delta)",
        [span(5, 11, "renamed"), span(11, 13)],
        [span(5, 13, "renamed"), span(13, 20)],
      ),
    ).toBe("this.{+onUpdate+}[-()-]{+(delta)+}");
  });

  it("merges a short line with one swapped word", () => {
    expect(merged("goto fail;", "goto out_free;", [span(5, 9)], [span(5, 13)])).toBe(
      "goto [-fail-]{+out_free+};",
    );
  });

  it("keeps pairs that don't line up apart", () => {
    expect(merged("let a = 1;", "let b = 1;", [], [span(4, 5)])).toBeNull();
    expect(merged("first()", "second()", [span(0, 7)], [span(0, 8)])).toBeNull();
  });
});

const line = (number: number, text: string, changes?: SemanticDiffChangeSpan[]) => ({
  line: number,
  text,
  ...(changes === undefined ? {} : { changes }),
});

function file(rows: SemanticDiffRow[], extra: Partial<SemanticDiffFile> = {}): SemanticDiffFile {
  return {
    status: "modified",
    old_path: "a.rs",
    new_path: "a.rs",
    language: "rs",
    additions: 0,
    deletions: 0,
    hunks: [{ old_start: 1, old_len: 1, new_start: 1, new_len: 1, rows }],
    ...extra,
  };
}

const shape = (rows: ReadonlyArray<DiffyRow>) =>
  rows.map((row) => {
    switch (row.kind) {
      case "context":
        return `  ${row.text}`;
      case "removed":
        return `- ${row.line.text}`;
      case "added":
        return `+ ${row.line.text}`;
      case "merged":
        return `~ ${row.new.text}`;
      case "moved":
        return `> ${row.line.text}${row.from === null ? "" : " (merged)"}`;
      case "move":
        return `# ${row.text}`;
    }
  });

describe("diffyHunkRows", () => {
  it("shows moved code once, where it arrived, with a note at each end", () => {
    const rows = diffyHunkRows(
      file(
        [
          { kind: "removed", old: line(1, "fn helper() {}", [span(0, 14, "unchanged_context")]) },
          { kind: "context", old_line: 2, new_line: 1, text: "fn main() {}" },
          { kind: "added", new: line(2, "fn helper() {}", [span(0, 14, "unchanged_context")]) },
        ],
        { moves: [{ old_start: 1, old_len: 1, new_start: 2, new_len: 1, item: "helper" }] },
      ),
    );
    expect(shape(rows[0]!)).toEqual([
      "# helper moved down to line 2",
      "  fn main() {}",
      "# moved down from line 1",
      "> fn helper() {}",
    ]);
  });

  it("hides a removed line whose text survives elsewhere, and keeps runs old before new", () => {
    const rows = diffyHunkRows(
      file([
        { kind: "removed", old: line(1, "let a = 1;", [span(0, 10, "unchanged_context")]) },
        {
          kind: "modified",
          old: line(2, "first()", [span(0, 7)]),
          new: line(1, "second()", [span(0, 8)]),
        },
        {
          kind: "modified",
          old: line(3, "third()", [span(0, 7)]),
          new: line(2, "fourth()", [span(0, 8)]),
        },
      ]),
    );
    expect(shape(rows[0]!)).toEqual(["- first()", "- third()", "+ second()", "+ fourth()"]);
  });

  it("merges a modified line of a semantic diff, not of a line diff", () => {
    const modified: SemanticDiffRow = {
      kind: "modified",
      old: line(1, "goto fail;", [span(5, 9, "novel_word")]),
      new: line(1, "goto out_free;", [span(5, 13, "novel_word")]),
    };
    expect(shape(diffyHunkRows(file([modified]))[0]!)).toEqual(["~ goto out_free;"]);
    expect(
      shape(diffyHunkRows(file([modified], { fallback: { kind: "no_grammar", message: "" } }))[0]!),
    ).toEqual(["- goto fail;", "+ goto out_free;"]);
  });
});

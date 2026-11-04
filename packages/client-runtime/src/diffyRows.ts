/**
 * Diffy's unified view of its display format, ported from diffy-ui (`crates/diffy-diff/src/merge.rs`,
 * `compare.rs` and `projection.rs`, `crates/diffy-ui/src/diff_view/frame.rs`) so clients draw
 * Diffy's rows the way Diffy does.
 */
import type {
  SemanticDiffChangeSpan,
  SemanticDiffFile,
  SemanticDiffLine,
  SemanticDiffMove,
  SemanticDiffRow,
} from "@t3tools/contracts";

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

type Spans = ReadonlyArray<SemanticDiffChangeSpan>;

// merge.rs

const MAX_MERGE_BYTES = 400;
const MIN_MERGE_KEPT = 0.4;
const RENAMED = "\u0000";

export interface MergePiece {
  readonly side: "old" | "new";
  readonly start: number;
  readonly end: number;
  readonly changed: boolean;
  readonly renamed: boolean;
}

const isSpace = (character: string) => /\s/u.test(character);

function utf8Length(text: string) {
  let length = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return length;
}

function solid(text: string) {
  let count = 0;
  for (const character of text) if (!isSpace(character)) count += 1;
  return count;
}

const marked = (spans: Spans): TextRange[] =>
  spans.filter((span) => span.intensity !== "unchanged_context");

const renamedOf = (spans: Spans): TextRange[] =>
  spans.filter((span) => span.intensity === "renamed");

const renamedAt = (spans: Spans, at: number) =>
  spans.some((span) => span.intensity === "renamed" && span.start === at);

type Kept = readonly [start: number, end: number, character: string];

function kept(
  text: string,
  marks: ReadonlyArray<TextRange>,
  renamed: ReadonlyArray<TextRange>,
): Kept[] {
  const out: Kept[] = [];
  let mark = 0;
  let at = 0;
  for (const character of text) {
    while (mark < marks.length && marks[mark]!.end <= at) mark += 1;
    const rename = renamed.find((range) => range.start === at);
    const current = marks[mark];
    if (rename !== undefined) {
      out.push([rename.start, rename.end, RENAMED]);
    } else if (
      !isSpace(character) &&
      !(current !== undefined && current.start <= at && at < current.end)
    ) {
      out.push([at, at + character.length, character]);
    }
    at += character.length;
  }
  return out;
}

function partitionPoint<T>(items: ReadonlyArray<T>, before: (item: T) => boolean) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (before(items[middle]!)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function skipSpace(text: string, from: number) {
  const rest = text.slice(from);
  return from + rest.length - rest.trimStart().length;
}

function pushNew(
  pieces: MergePiece[],
  range: TextRange,
  marks: ReadonlyArray<TextRange>,
  renamed: ReadonlyArray<TextRange>,
) {
  let at = range.start;
  for (const mark of marks) {
    const start = Math.max(mark.start, range.start);
    const end = Math.min(mark.end, range.end);
    if (start >= end) continue;
    if (at < start)
      pieces.push({ side: "new", start: at, end: start, changed: false, renamed: false });
    const rename = renamed.some((candidate) => candidate.start === mark.start);
    pieces.push({ side: "new", start, end, changed: true, renamed: rename });
    at = end;
  }
  if (at < range.end) {
    pieces.push({ side: "new", start: at, end: range.end, changed: false, renamed: false });
  }
}

/**
 * One line for a removed line and the added line it became: the new text with the removed pieces
 * where they were. Null when the two don't line up closely enough to read as one.
 */
export function mergePair(
  old: string,
  next: string,
  oldSpans: Spans,
  newSpans: Spans,
): ReadonlyArray<MergePiece> | null {
  if (utf8Length(old) > MAX_MERGE_BYTES || utf8Length(next) > MAX_MERGE_BYTES) return null;
  const oldMarks = marked(oldSpans);
  const newMarks = marked(newSpans);
  const renamed = renamedOf(newSpans);
  const oldKept = kept(old, oldMarks, renamedOf(oldSpans));
  const newKept = kept(next, newMarks, renamed);
  if (
    oldKept.length !== newKept.length ||
    oldKept.some((entry, index) => entry[2] !== newKept[index]![2])
  ) {
    return null;
  }
  const renamedLength = renamed.reduce(
    (sum, range) => sum + solid(next.slice(range.start, range.end)),
    0,
  );
  const longest = Math.max(solid(old), solid(next));
  const gaps = (marks: ReadonlyArray<TextRange>, keptOf: ReadonlyArray<Kept>) => {
    const at: number[] = [];
    for (const range of marks) {
      const point = partitionPoint(keptOf, (entry) => entry[0] < range.start);
      if (at.at(-1) !== point) at.push(point);
    }
    return at;
  };
  const swap =
    newKept.length > 0 &&
    (() => {
      const [a, b] = [gaps(oldMarks, oldKept), gaps(newMarks, newKept)];
      return a.length === 1 && b.length === 1 && a[0] === b[0];
    })();
  const oneSided = oldMarks.length === 0 || newMarks.length === 0;
  if (
    !swap &&
    !oneSided &&
    longest > 0 &&
    newKept.length + renamedLength < MIN_MERGE_KEPT * longest
  ) {
    return null;
  }

  const removed: Array<{ index: number; start: number; end: number }> = [];
  for (const range of oldMarks) {
    if (renamedAt(oldSpans, range.start)) continue;
    const index = partitionPoint(oldKept, (entry) => entry[0] < range.start);
    const last = removed.at(-1);
    if (
      last !== undefined &&
      last.index === index &&
      old.slice(last.end, range.start).trim() === ""
    ) {
      last.end = range.end;
    } else {
      removed.push({ index, start: range.start, end: range.end });
    }
  }
  const pieces: MergePiece[] = [];
  let at = 0;
  for (const { index, start, end } of removed) {
    const after = index > 0 ? (newKept[index - 1]?.[1] ?? 0) : 0;
    const insert = Math.max(skipSpace(next, after), at);
    pushNew(pieces, { start: at, end: insert }, newMarks, renamed);
    const lead = start - old.slice(0, start).replace(/[ \t]+$/, "").length;
    const tail = old.slice(end);
    const trail = tail.length - tail.replace(/^[ \t]+/, "").length;
    const spacedBefore = /\s$/u.test(next.slice(0, insert));
    const spacedAfter = /^\s/u.test(next.slice(insert));
    if (insert > 0 && !spacedBefore && lead > 0) {
      pieces.push({ side: "old", start: start - lead, end: start, changed: false, renamed: false });
    }
    pieces.push({ side: "old", start, end, changed: true, renamed: false });
    if (insert < next.length && !spacedAfter && trail > 0) {
      pieces.push({ side: "old", start: end, end: end + trail, changed: false, renamed: false });
    }
    at = insert;
  }
  pushNew(pieces, { start: at, end: next.length }, newMarks, renamed);
  return pieces;
}

// Composing a merged line (frame.rs `compose`).

/** How a piece of a drawn line is marked. */
export type PieceMark =
  /** The line's own text. */
  | "none"
  /** A changed word: green on the new side, red on the old. */
  | "word"
  /** Removed text kept in a merged line, or in a removed line of a semantic diff. */
  | "removed"
  /** Unchanged old text or spacing beside a removed piece, drawn as removed text. */
  | "gap"
  /** An identifier the semantic diff matched as renamed. */
  | "renamed";

export interface LinePiece {
  readonly text: string;
  readonly side: "old" | "new";
  /** Where `text` starts in that side's line, for its syntax spans; -1 for added spacing. */
  readonly offset: number;
  readonly mark: PieceMark;
}

function joinWhitespaceGaps(ranges: ReadonlyArray<TextRange>, text: string): TextRange[] {
  const joined: TextRange[] = [];
  for (const range of ranges) {
    const last = joined.at(-1);
    if (
      last !== undefined &&
      range.start >= last.end &&
      text.slice(last.end, range.start).trim() === ""
    ) {
      joined[joined.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
      continue;
    }
    joined.push(range);
  }
  return joined;
}

/** Changed words between two marked pieces only by whitespace count as one changed phrase. */
function joinWordGaps(pieces: LinePiece[]): LinePiece[] {
  return pieces.map((piece, index) =>
    piece.mark === "none" &&
    piece.text.trim() === "" &&
    pieces[index - 1]?.mark === "word" &&
    pieces[index + 1]?.mark === "word"
      ? { ...piece, mark: "word" }
      : piece,
  );
}

function trimmedLine(line: SemanticDiffLine): { text: string; spans: Spans } {
  const text = line.text.trimEnd();
  const lead = text.length - text.trimStart().length;
  const spans = (line.changes ?? []).flatMap((span) => {
    const start = Math.max(span.start, lead);
    const end = Math.min(span.end, text.length);
    return start < end ? [{ ...span, start, end }] : [];
  });
  return { text, spans };
}

/** A removed line and the added line it became, drawn as one; null when they don't merge. */
function mergedLine(
  old: SemanticDiffLine,
  next: SemanticDiffLine,
): ReadonlyArray<LinePiece> | null {
  const [a, b] = [trimmedLine(old), trimmedLine(next)];
  const pieces = mergePair(a.text, b.text, a.spans, b.spans);
  if (pieces === null) return null;
  const out: LinePiece[] = [];
  let composed = "";
  let previousOld: number | null = null;
  for (const piece of pieces) {
    const end = previousOld;
    previousOld = null;
    if (end !== null && piece.side === "new" && piece.changed && !/\s$/u.test(composed)) {
      out.push({ text: " ", side: "old", offset: -1, mark: "gap" });
      composed += " ";
    }
    const text = (piece.side === "old" ? a : b).text.slice(piece.start, piece.end);
    const mark: PieceMark =
      piece.side === "old"
        ? piece.changed
          ? "removed"
          : "gap"
        : piece.changed
          ? piece.renamed
            ? "renamed"
            : "word"
          : "none";
    out.push({ text, side: piece.side, offset: piece.start, mark });
    composed += text;
    if (piece.side === "old") previousOld = piece.end;
  }
  return joinWordGaps(out);
}

function covers(ranges: ReadonlyArray<TextRange>, text: string) {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return start < end && ranges.some((range) => range.start <= start && range.end >= end);
}

function piecesOf(
  line: SemanticDiffLine,
  side: "old" | "new",
  marks: ReadonlyArray<{ readonly range: TextRange; readonly mark: PieceMark }>,
): LinePiece[] {
  const sorted = [...marks].sort((x, y) => x.range.start - y.range.start);
  const out: LinePiece[] = [];
  let at = 0;
  for (const { range, mark } of sorted) {
    const start = Math.max(range.start, at);
    if (start >= range.end) continue;
    if (at < start) out.push({ text: line.text.slice(at, start), side, offset: at, mark: "none" });
    out.push({ text: line.text.slice(start, range.end), side, offset: start, mark });
    at = range.end;
  }
  if (at < line.text.length) {
    out.push({ text: line.text.slice(at), side, offset: at, mark: "none" });
  }
  return out;
}

/**
 * A whole removed or added line's pieces. A semantic diff marks the changed words of every line,
 * keeps removed words as removed text and underlines renames; a line diff marks words only where
 * they don't cover the line, since the line's own tint already says so.
 *
 * @public
 */
export function sideLine(
  line: SemanticDiffLine,
  side: "old" | "new",
  semantic: boolean,
): { readonly pieces: ReadonlyArray<LinePiece>; readonly whole: boolean } {
  const changes = line.changes ?? [];
  const words = joinWhitespaceGaps(
    changes.filter(
      (span) => span.intensity !== "unchanged_context" && span.intensity !== "renamed",
    ),
    line.text,
  );
  const whole = !semantic && covers(words, line.text);
  const marks: Array<{ range: TextRange; mark: PieceMark }> = whole
    ? []
    : words.map((range) => ({
        range,
        mark: semantic && side === "old" ? "removed" : "word",
      }));
  if (semantic) {
    for (const range of renamedOf(changes)) marks.push({ range, mark: "renamed" });
  }
  return { pieces: piecesOf(line, side, marks), whole };
}

// compare.rs and projection.rs

const MOVE_GROUP_GAP = 8;

/** The first move of each run of moves that left the same item, which their notes share. */
function moveLeaders(moves: ReadonlyArray<SemanticDiffMove>): number[] {
  const order = moves
    .map((_, index) => index)
    .sort((x, y) => moves[x]!.new_start - moves[y]!.new_start);
  const leaders = moves.map((_, index) => index);
  let group: { leader: number; end: number } | null = null;
  for (const index of order) {
    const move = moves[index]!;
    if (
      group !== null &&
      move.from !== undefined &&
      move.from === moves[group.leader]!.from &&
      move.from !== move.into &&
      Math.max(0, move.new_start - group.end) <= MOVE_GROUP_GAP
    ) {
      leaders[index] = group.leader;
      group.end = Math.max(group.end, move.new_start + move.new_len);
    } else {
      group = { leader: index, end: move.new_start + move.new_len };
    }
  }
  return leaders;
}

/** A row of the unified view, in drawing order. */
export type DiffyRow =
  | {
      readonly kind: "context";
      readonly oldLine: number;
      readonly newLine: number;
      readonly text: string;
      readonly syntax: SemanticDiffLine["syntax"];
    }
  | { readonly kind: "removed"; readonly line: SemanticDiffLine }
  | { readonly kind: "added"; readonly line: SemanticDiffLine }
  | {
      readonly kind: "merged";
      readonly old: SemanticDiffLine;
      readonly new: SemanticDiffLine;
      readonly pieces: ReadonlyArray<LinePiece>;
    }
  | {
      /** An added line the semantic diff found moved here; merged with its old line when they merge. */
      readonly kind: "moved";
      readonly line: SemanticDiffLine;
      readonly from: SemanticDiffLine | null;
      readonly pieces: ReadonlyArray<LinePiece> | null;
    }
  | {
      /** Where moved code left (`here: false`) or arrived. */
      readonly kind: "move";
      readonly move: number;
      readonly here: boolean;
      /** Whether the other end is above; null when it isn't in the rows. */
      readonly up: boolean | null;
      readonly partner: { readonly hunk: number; readonly row: number } | null;
      readonly text: string;
    };

type Step =
  | { readonly kind: "context"; readonly row: Extract<SemanticDiffRow, { kind: "context" }> }
  | { readonly kind: "removed"; readonly old: SemanticDiffLine }
  | { readonly kind: "added"; readonly new: SemanticDiffLine }
  | { readonly kind: "paired"; readonly old: SemanticDiffLine; readonly new: SemanticDiffLine }
  | {
      readonly kind: "merged";
      readonly old: SemanticDiffLine;
      readonly new: SemanticDiffLine;
      readonly pieces: ReadonlyArray<LinePiece>;
    }
  | { readonly kind: "hidden"; readonly old: SemanticDiffLine }
  | { readonly kind: "moved"; readonly new: SemanticDiffLine }
  | { readonly kind: "movedHere" | "movedAway"; readonly move: number };

function linesOf(step: Step): [old: number | null, next: number | null] {
  switch (step.kind) {
    case "context":
      return [step.row.old_line, step.row.new_line];
    case "removed":
    case "hidden":
      return [step.old.line, null];
    case "added":
    case "moved":
      return [null, step.new.line];
    case "paired":
    case "merged":
      return [step.old.line, step.new.line];
    case "movedHere":
    case "movedAway":
      return [null, null];
  }
}

const lineCount = (count: number) => (count === 1 ? "1 line" : `${count} lines`);

function moveText(
  moves: ReadonlyArray<SemanticDiffMove>,
  leaders: ReadonlyArray<number>,
  index: number,
  here: boolean,
  up: boolean | null,
): string {
  const move = moves[index]!;
  const elsewhere = move.from !== undefined && move.from !== move.into;
  const toward = up === true ? " up" : up === false ? " down" : "";
  const away = up === true ? " down" : up === false ? " up" : "";
  const pieces = moves.filter((_, candidate) => leaders[candidate] === index);
  if (here && elsewhere && pieces.length > 1) {
    const first = Math.min(...pieces.map((piece) => piece.old_start));
    const last = Math.max(...pieces.map((piece) => piece.old_start + piece.old_len - 1));
    return `${pieces.length} pieces moved from ${move.from} · lines ${first}–${last}`;
  }
  if (here) {
    return elsewhere
      ? `moved from ${move.from} · line ${move.old_start}`
      : `moved${away} from line ${move.old_start}`;
  }
  if (move.item !== undefined && !elsewhere) {
    return `${move.item} moved${toward} to line ${move.new_start}`;
  }
  return elsewhere
    ? `${lineCount(move.old_len)} moved into ${move.into ?? "another item"} · line ${move.new_start}`
    : `${lineCount(move.old_len)} moved${toward} to line ${move.new_start}`;
}

/**
 * Whether Diffy's semantic diff produced the file's rows. A file that fell back to a line diff is
 * drawn as one: tinted lines, old lines before new ones, no merging.
 *
 * @public
 */
export function isSemanticFile(file: SemanticDiffFile) {
  return file.fallback === undefined && file.binary !== true;
}

/** The file's hunks as Diffy's unified view draws them. */
export function diffyHunkRows(file: SemanticDiffFile): ReadonlyArray<ReadonlyArray<DiffyRow>> {
  const semantic = isSemanticFile(file);
  const moves = semantic ? (file.moves ?? []) : [];
  const leaders = moveLeaders(moves);
  const oldLines = new Map<number, SemanticDiffLine>();
  const newLines = new Map<number, SemanticDiffLine>();
  for (const hunk of file.hunks ?? []) {
    for (const row of hunk.rows) {
      if (row.kind === "context") {
        oldLines.set(row.old_line, { line: row.old_line, text: row.text });
        newLines.set(row.new_line, { line: row.new_line, text: row.text });
      }
      if (row.kind === "removed" || row.kind === "modified") oldLines.set(row.old.line, row.old);
      if (row.kind === "added" || row.kind === "modified") newLines.set(row.new.line, row.new);
    }
  }
  const spansOf = (line: number) => oldLines.get(line)?.changes ?? [];
  const removes = (line: number) =>
    spansOf(line).some((span) => span.intensity === "novel" || span.intensity === "novel_word");
  const movedFrom = (newLine: number): SemanticDiffLine | null => {
    const move = moves.find(
      (candidate) =>
        newLine >= candidate.new_start && newLine < candidate.new_start + candidate.new_len,
    );
    if (move === undefined) return null;
    const oldLine = move.old_start + (newLine - move.new_start);
    if (oldLine >= move.old_start + move.old_len || !removes(oldLine)) return null;
    const [old, next] = [oldLines.get(oldLine), newLines.get(newLine)];
    if (old === undefined || next === undefined) return null;
    return mergePair(old.text, next.text, old.changes ?? [], next.changes ?? []) === null
      ? null
      : old;
  };
  const within = (line: number) =>
    moves.find((move) => line >= move.old_start && line < move.old_start + move.old_len);
  const hiddenOld = (line: number) => {
    const move = within(line);
    if (move !== undefined) {
      return !removes(line) || movedFrom(move.new_start + (line - move.old_start))?.line === line;
    }
    const blank = oldLines.get(line)?.text.trim() === "";
    return (
      blank && (within(line + 1) !== undefined || within(line - 1) !== undefined) && !removes(line)
    );
  };
  const movedNew = (line: number) =>
    moves.some((move) => line >= move.new_start && line < move.new_start + move.new_len);
  const dissolved = (old: SemanticDiffLine) =>
    old.text.trim() !== "" &&
    (old.changes ?? []).every(
      (span) => span.intensity === "unchanged_context" || span.intensity === "renamed",
    );

  const foldBlock = (block: Step[]): Step[] => {
    if (!semantic) return block;
    // merge_pairs
    let steps = block.map((step): Step => {
      if (step.kind !== "paired") return step;
      const pieces = mergedLine(step.old, step.new);
      return pieces === null ? step : { kind: "merged", old: step.old, new: step.new, pieces };
    });
    // fold_moves
    if (moves.length > 0) {
      const noted = moves.map(() => [false, false]);
      const folded: Step[] = [];
      for (const step of steps) {
        const [o, n] = linesOf(step);
        const hide = o !== null && hiddenOld(o);
        const moved = n !== null && movedNew(n);
        moves.forEach((move, index) => {
          if (o !== null && o === move.old_start && !noted[index]![0]) {
            noted[index]![0] = true;
            folded.push({ kind: "movedAway", move: index });
          }
          if (moved && n === move.new_start && !noted[index]![1] && leaders[index] === index) {
            noted[index]![1] = true;
            folded.push({ kind: "movedHere", move: index });
          }
        });
        if (step.kind === "removed" && hide) folded.push({ kind: "hidden", old: step.old });
        else if (step.kind === "added" && moved) folded.push({ kind: "moved", new: step.new });
        else if (step.kind === "paired" && (hide || moved)) {
          folded.push(
            hide ? { kind: "hidden", old: step.old } : { kind: "removed", old: step.old },
          );
          folded.push(moved ? { kind: "moved", new: step.new } : { kind: "added", new: step.new });
        } else folded.push(step);
      }
      steps = folded;
    }
    // hide_dissolved
    return steps.flatMap((step): Step[] => {
      if (step.kind === "removed" && dissolved(step.old))
        return [{ kind: "hidden", old: step.old }];
      if (step.kind === "paired" && dissolved(step.old)) {
        return [
          { kind: "hidden", old: step.old },
          { kind: "added", new: step.new },
        ];
      }
      return [step];
    });
  };

  // Unified: a run of removed, added and paired lines shows all its old lines, then its new ones.
  const project = (steps: ReadonlyArray<Step>): DiffyRow[] => {
    const rows: DiffyRow[] = [];
    let run: Step[] = [];
    const flush = () => {
      for (const step of run) {
        if (step.kind === "removed" || step.kind === "paired")
          rows.push({ kind: "removed", line: step.old });
      }
      for (const step of run) {
        if (step.kind === "added" || step.kind === "paired")
          rows.push({ kind: "added", line: step.new });
      }
      run = [];
    };
    for (const step of steps) {
      if (step.kind === "removed" || step.kind === "added" || step.kind === "paired") {
        run.push(step);
        continue;
      }
      flush();
      switch (step.kind) {
        case "context":
          rows.push({
            kind: "context",
            oldLine: step.row.old_line,
            newLine: step.row.new_line,
            text: step.row.text,
            syntax: step.row.syntax,
          });
          break;
        case "merged":
          rows.push({ kind: "merged", old: step.old, new: step.new, pieces: step.pieces });
          break;
        case "moved": {
          const from = movedFrom(step.new.line);
          rows.push({
            kind: "moved",
            line: step.new,
            from,
            pieces: from === null ? null : mergedLine(from, step.new),
          });
          break;
        }
        case "movedHere":
        case "movedAway":
          rows.push({
            kind: "move",
            move: step.move,
            here: step.kind === "movedHere",
            up: null,
            partner: null,
            text: "",
          });
          break;
        case "hidden":
          break;
      }
    }
    flush();
    return rows;
  };

  const hunks = (file.hunks ?? []).map((hunk) => {
    const steps: Step[] = [];
    let block: Step[] = [];
    for (const row of hunk.rows) {
      if (row.kind === "context") {
        steps.push(...foldBlock(block), { kind: "context", row });
        block = [];
      } else if (row.kind === "removed") block.push({ kind: "removed", old: row.old });
      else if (row.kind === "added") block.push({ kind: "added", new: row.new });
      else block.push({ kind: "paired", old: row.old, new: row.new });
    }
    steps.push(...foldBlock(block));
    return project(steps);
  });

  // Each note points at its other end: a piece's departure at its group's arrival.
  const notes = hunks.flatMap((rows, hunk) =>
    rows.flatMap((row, index) =>
      row.kind === "move" ? [{ hunk, row: index, note: row, order: 0 }] : [],
    ),
  );
  notes.forEach((entry, order) => (entry.order = order));
  return hunks.map((rows, hunk) =>
    rows.map((row, index): DiffyRow => {
      if (row.kind !== "move") return row;
      const self = notes.find((entry) => entry.hunk === hunk && entry.row === index)!;
      const target = row.here ? row.move : leaders[row.move]!;
      const partner = notes.find(
        (entry) =>
          entry.note.here !== row.here &&
          (entry.note.move === target || (row.here && leaders[entry.note.move] === row.move)),
      );
      const up = partner === undefined ? null : partner.order < self.order;
      return {
        ...row,
        up,
        partner: partner === undefined ? null : { hunk: partner.hunk, row: partner.row },
        text: moveText(moves, leaders, row.move, row.here, up),
      };
    }),
  );
}

/**
 * What the semantic diff found in a file, for its header: renames, moves, items and edits.
 *
 * @public
 */
export function semanticSummary(file: SemanticDiffFile): string | null {
  if (!isSemanticFile(file)) return null;
  let added = 0;
  let removed = 0;
  let edits = 0;
  for (const item of file.outline ?? []) {
    if (item.change === "added") added += 1;
    else if (item.change === "removed") removed += 1;
    else if (item.change === "edited") edits += item.edits ?? 0;
  }
  const parts = (
    [
      [file.renames?.length ?? 0, "rename", "renames"],
      [file.moves?.length ?? 0, "move", "moves"],
      [added, "added", "added"],
      [removed, "removed", "removed"],
      [edits, "edit", "edits"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

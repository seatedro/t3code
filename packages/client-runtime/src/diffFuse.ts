import type { SemanticDiffLine } from "@t3tools/contracts";

export interface FusedSegment {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
  /** Offset of `text` in the old line for `removed`, else in the new line, for syntax spans. */
  readonly offset: number;
}

// Below this share of the new line kept, struck and inserted words outweigh the line itself.
const MIN_KEPT_SHARE = 0.5;

function changedMask(line: SemanticDiffLine): Uint8Array {
  const mask = new Uint8Array(line.text.length);
  for (const span of line.changes ?? []) {
    if (span.intensity !== "unchanged_context") mask.fill(1, span.start, span.end);
  }
  return mask;
}

/**
 * One line for a modified row: removed words struck in place before the words that replaced them.
 * Null when the two sides' unchanged text does not line up, or too little of the line survived.
 */
export function fuseModifiedLine(
  old: SemanticDiffLine,
  next: SemanticDiffLine,
): ReadonlyArray<FusedSegment> | null {
  const oldChanged = changedMask(old);
  const newChanged = changedMask(next);
  const segments: FusedSegment[] = [];
  const push = (kind: FusedSegment["kind"], text: string, offset: number) => {
    if (text === "") return;
    const last = segments.at(-1);
    if (last?.kind === kind && last.offset + last.text.length === offset) {
      segments[segments.length - 1] = { kind, text: last.text + text, offset: last.offset };
    } else {
      segments.push({ kind, text, offset });
    }
  };

  let o = 0;
  let n = 0;
  let kept = 0;
  while (o < old.text.length || n < next.text.length) {
    const removedStart = o;
    while (o < old.text.length && oldChanged[o] === 1) o += 1;
    push("removed", old.text.slice(removedStart, o), removedStart);
    const addedStart = n;
    while (n < next.text.length && newChanged[n] === 1) n += 1;
    push("added", next.text.slice(addedStart, n), addedStart);

    const sameStart = n;
    while (
      o < old.text.length &&
      n < next.text.length &&
      oldChanged[o] === 0 &&
      newChanged[n] === 0 &&
      old.text[o] === next.text[n]
    ) {
      o += 1;
      n += 1;
    }
    const same = next.text.slice(sameStart, n);
    kept += same.trim().length;
    push("same", same, sameStart);
    if (n > sameStart) continue;

    // Diffy's spans leave out whitespace beside a change; fold it into that side's change.
    if (n < next.text.length && newChanged[n] === 0 && /\s/.test(next.text[n]!)) {
      push("added", next.text[n]!, n);
      n += 1;
    } else if (o < old.text.length && oldChanged[o] === 0 && /\s/.test(old.text[o]!)) {
      push("removed", old.text[o]!, o);
      o += 1;
    } else if (o < old.text.length || n < next.text.length) {
      // Unchanged text on one side that the other side doesn't share.
      return null;
    }
  }

  const total = next.text.trim().length;
  return total > 0 && kept / total >= MIN_KEPT_SHARE ? segments : null;
}

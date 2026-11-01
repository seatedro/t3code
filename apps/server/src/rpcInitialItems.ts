import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Emits `items` (then `completion`, if given) as one RPC chunk, so a completion marker skips an ACK round trip. */
export function rpcInitialItems<A, B = never>(
  items: ReadonlyArray<A>,
  completion?: B,
): Stream.Stream<A | B> {
  let pending: ReadonlyArray<A | B> | undefined =
    completion === undefined ? items : [...items, completion];
  return Stream.unwrap(
    Effect.sync(() => {
      const initial = pending;
      // concat retains the initial stream during live tailing; release delivered snapshots and rows.
      pending = undefined;
      return initial === undefined ? Stream.empty : Stream.fromIterable(initial);
    }),
  );
}

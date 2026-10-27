import type { VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  selectVcsKind,
  selectVcsProblemCode,
  selectVcsProblemMessage,
  vcsProblemBlockingReason,
  vcsProblemDescription,
  vcsTerminologyFor,
} from "./vcsPresentation.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const staleJj = status({
  vcs: { kind: "jj", problem: { code: "stale", message: "Workspace is stale." } },
});

describe("vcsTerminologyFor", () => {
  it("uses workspace and bookmark for jj, worktree and branch otherwise", () => {
    expect(vcsTerminologyFor("jj")).toMatchObject({ workspace: "Workspace", ref: "Bookmark" });
    expect(vcsTerminologyFor("git")).toMatchObject({ workspace: "Worktree", ref: "Branch" });
    expect(vcsTerminologyFor(null)).toBe(vcsTerminologyFor("git"));
  });
});

describe("vcs status selectors", () => {
  it("read kind and problem from the latest status, and null before one arrives", () => {
    const initial = AsyncResult.initial<VcsStatusResult, never>();
    expect(selectVcsKind(initial)).toBeNull();
    expect(selectVcsProblemCode(initial)).toBeNull();

    const loaded = AsyncResult.success<VcsStatusResult, never>(staleJj);
    expect(selectVcsKind(loaded)).toBe("jj");
    expect(selectVcsProblemCode(loaded)).toBe("stale");
    expect(selectVcsProblemMessage(loaded)).toBe("Workspace is stale.");

    expect(selectVcsKind(AsyncResult.success<VcsStatusResult, never>(status()))).toBeNull();
  });

  it("does not notify kind subscribers when unrelated status fields change", () => {
    const registry = AtomRegistry.make();
    const statusAtom = Atom.make(
      AsyncResult.success<VcsStatusResult, never>(status({ vcs: { kind: "jj" } })),
    );
    const kindAtom = Atom.map(statusAtom, selectVcsKind);
    const kinds: Array<string | null> = [];
    const unsubscribe = registry.subscribe(kindAtom, (kind) => kinds.push(kind), {
      immediate: true,
    });

    registry.set(
      statusAtom,
      AsyncResult.success(status({ vcs: { kind: "jj" }, aheadCount: 3, refName: "other" })),
    );
    registry.set(statusAtom, AsyncResult.success(status({ vcs: { kind: "git" } })));
    unsubscribe();

    expect(kinds).toEqual(["jj", "git"]);
  });
});

describe("vcsProblemBlockingReason", () => {
  it("blocks on unsupported and error problems but not on a repairable stale workspace", () => {
    expect(
      vcsProblemBlockingReason(
        status({
          vcs: { kind: "jj", problem: { code: "unsupported", message: "Not colocated." } },
        }),
      ),
    ).toBe("Not colocated.");
    expect(
      vcsProblemBlockingReason(
        status({ vcs: { kind: "jj", problem: { code: "error", message: "jj crashed." } } }),
      ),
    ).toBe("jj crashed.");
    expect(vcsProblemBlockingReason(staleJj)).toBeNull();
    expect(vcsProblemBlockingReason(status())).toBeNull();
  });

  it("offers repair only for a stale workspace", () => {
    expect(vcsProblemDescription({ code: "stale", message: "Stale." })).toBe(
      "Stale. Repair available.",
    );
    expect(vcsProblemDescription({ code: "error", message: "Broken." })).toBe("Broken.");
  });
});

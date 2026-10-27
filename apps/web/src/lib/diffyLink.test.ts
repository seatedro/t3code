import { describe, expect, it } from "vite-plus/test";

import { isDiffyPullRequestHref } from "./diffyLink";

describe("isDiffyPullRequestHref", () => {
  it("keeps GitHub pull request links on the diffy scheme and nothing else", () => {
    expect(isDiffyPullRequestHref("diffy://github.com/seatedro/t3code/pull/12")).toBe(true);
    expect(isDiffyPullRequestHref("diffy://github.com/seatedro/t3code/pull/12/files")).toBe(true);
    expect(isDiffyPullRequestHref("diffy://github.com/seatedro/t3code/issues/12")).toBe(false);
    expect(isDiffyPullRequestHref("diffy://example.com/seatedro/t3code/pull/12")).toBe(false);
    expect(isDiffyPullRequestHref("diffy://user@github.com/seatedro/t3code/pull/12")).toBe(false);
    expect(isDiffyPullRequestHref("https://github.com/seatedro/t3code/pull/12")).toBe(false);
  });
});

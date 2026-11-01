import { useAtomMount } from "@effect/atom-react";

import { threadCatchUp } from "../state/threads";

export function ThreadCatchUp() {
  useAtomMount(threadCatchUp.atom);
  return null;
}

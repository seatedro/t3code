import { createFileRoute } from "@tanstack/react-router";

import { MemorySettingsPanel } from "../components/settings/MemorySettingsPanel";

export const Route = createFileRoute("/_chat/settings/memory")({
  component: MemorySettingsPanel,
});

import { ProviderDriverKind, type UsageProviderKind } from "@t3tools/contracts";
import { USAGE_PROVIDER_COLORS, USAGE_PROVIDER_ORDER } from "@t3tools/client-runtime/usage-ledger";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

const LABELS: Record<UsageProviderKind, { readonly label: string; readonly driver: string }> = {
  claude: { label: "Claude Code", driver: "claudeAgent" },
  codex: { label: "Codex", driver: "codex" },
  cursor: { label: "Cursor", driver: "cursor" },
  grok: { label: "Grok Build", driver: "grok" },
  opencode: { label: "OpenCode", driver: "opencode" },
  antigravity: { label: "Antigravity", driver: "antigravity" },
  pi: { label: "Pi", driver: "pi" },
  muse: { label: "Muse Code", driver: "muse" },
};

export const PROVIDER_PRESENTATION = Object.fromEntries(
  USAGE_PROVIDER_ORDER.map((provider) => [
    provider,
    {
      label: LABELS[provider].label,
      color: USAGE_PROVIDER_COLORS[provider],
      driverKind: ProviderDriverKind.make(LABELS[provider].driver),
    },
  ]),
) as Record<UsageProviderKind, UsageProviderPresentation>;

export const PROVIDER_ORDER: readonly UsageProviderKind[] = USAGE_PROVIDER_ORDER;

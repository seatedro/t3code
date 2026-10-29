import { requiredScopesForServerSettingsPatch } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useEnvironmentScopes } from "../../state/session";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Saved on the environment serving this app, whatever the settings scope selects. */
export function TailnetTrustSettings() {
  const enabled = usePrimarySettings((settings) => settings.tailnetTrustEnabled);
  const login = usePrimarySettings((settings) => settings.tailnetTrustLogin);
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Whoever sets these decides who gets a full session without a code, so it takes a full session.
  const canWrite = useEnvironmentScopes(
    primaryEnvironmentId,
    requiredScopesForServerSettingsPatch({ tailnetTrustEnabled: true }),
  );

  return (
    <>
      <SettingsRow
        {...searchableSetting("tailnet-trust")}
        description="Devices signed in to this machine's Tailscale account connect over your tailnet without a pairing code. Anyone signed in to that account counts as you. Turning this off signs those devices out."
        control={
          <Switch
            checked={enabled}
            disabled={!canWrite}
            onCheckedChange={(checked) => updateSettings({ tailnetTrustEnabled: Boolean(checked) })}
            aria-label="Trust my Tailscale devices"
          />
        }
      />
      {enabled ? (
        <SettingsRow
          title="Tailscale login for tagged machines"
          description="Only needed when this machine is a tagged Tailscale node. Otherwise it trusts the account it's signed in as."
          control={
            <Input
              key={login}
              size="sm"
              aria-label="Tailscale login for tagged machines"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              placeholder="you@github"
              defaultValue={login}
              disabled={!canWrite}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== login) updateSettings({ tailnetTrustLogin: value });
              }}
            />
          }
        />
      ) : null}
    </>
  );
}

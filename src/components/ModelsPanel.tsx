import { useCallback, useEffect, useState } from "react";
import InstalledModelsSection from "./InstalledModelsSection";
import { HubBrowserSettingsSection } from "./HubBrowser";
import {
  api,
  type CatalogModel,
  type PlatformCapabilities,
  type RevolverSettingsView,
} from "../revolver";

type Props = {
  models: CatalogModel[];
  platform: PlatformCapabilities | null;
  onRefresh: () => void;
  onError: (message: string) => void;
};

export default function ModelsPanel({ models, platform, onRefresh, onError }: Props) {
  const [settings, setSettings] = useState<RevolverSettingsView | null>(null);

  const loadSettings = useCallback(() => {
    api.getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSaved = useCallback(() => {
    loadSettings();
    onRefresh();
  }, [loadSettings, onRefresh]);

  return (
    <div className="config-layout">
      <InstalledModelsSection
        models={models}
        platform={platform}
        onRefresh={onRefresh}
        onError={onError}
      />
      <HubBrowserSettingsSection
        settings={settings}
        platform={platform}
        compact={false}
        onSaved={handleSaved}
        onError={onError}
      />
    </div>
  );
}

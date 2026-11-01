import { Download, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { matchDocsLanguage } from "@marinara-engine/shared";
import { useDocsLanguageBusy, useDocsLanguageChoice } from "../../../hooks/use-docs-language";
import { useDownloadUILanguage, useUILanguages } from "../../../hooks/use-ui-languages";
import { activateLocale } from "../../../localization/i18n";
import { APP_LANGUAGE_OPTIONS } from "../../../localization/locale-loader";
import { useUIStore } from "../../../stores/ui.store";
import { HelpTooltip } from "../../ui/HelpTooltip";
import { LanguagePicker } from "../../ui/LanguagePicker";
import { useDocsLanguageSwitch } from "./DocsLanguageControl";
import { SETTINGS_BUTTON_CLASS } from "./SettingControls";

export function UILanguageSetting({ anchorId }: { anchorId: string }) {
  const { t } = useTranslation();
  const language = useUIStore((state) => state.language);
  const setLanguage = useUIStore((state) => state.setLanguage);
  const status = useUILanguages();
  const download = useDownloadUILanguage();
  const docs = useDocsLanguageChoice();
  const switchDocsLanguage = useDocsLanguageSwitch();
  // The help-pages download and the app-language download must not overlap (the server answers 409).
  const docsBusy = useDocsLanguageBusy().busy;

  const selectLanguage = async (selected: string, refresh = false) => {
    let applied = selected;
    try {
      if (selected !== "en" && (refresh || !status.data?.installed.includes(selected))) {
        await download.mutateAsync(selected);
        applied = await activateLocale(selected, true);
        setLanguage(applied);
      } else {
        setLanguage(selected);
      }
    } catch {
      toast.error(t("settings.application.language.downloadFailed"));
      return;
    }
    // The help pages follow the app language unless the reader picked one. Re-downloading the same language
    // changes nothing for them. The toast waits for the help-pages request, so it never reports a switch that failed.
    if (refresh || !docs.following) return;
    const languageLabel = APP_LANGUAGE_OPTIONS.find((option) => option.id === applied)?.label ?? applied;
    const target = matchDocsLanguage(applied, docs.status.data?.available.map((option) => option.code) ?? []) ?? "en";
    if (target === docs.active) {
      toast.success(t("settings.application.language.changed", { language: languageLabel }));
      return;
    }
    const result = await switchDocsLanguage(target, null, true);
    if (!result.ok) return;
    toast.success(
      result.downloaded
        ? t("settings.application.language.changedFollowingDownloaded", { language: languageLabel, docs: result.label })
        : t(
            target === "en"
              ? "settings.application.language.changed"
              : "settings.application.language.changedFollowing",
            {
              language: languageLabel,
            },
          ),
    );
  };

  return (
    <div id={anchorId} className="flex scroll-mt-3 flex-col gap-1">
      <label htmlFor={`${anchorId}-select`} className="inline-flex items-center gap-1 text-xs font-medium">
        {t("settings.application.language.label")}
        <HelpTooltip text={t("settings.application.language.help")} />
      </label>
      <LanguagePicker
        id={`${anchorId}-select`}
        label={t("settings.application.language.label")}
        value={language}
        onChange={(code) => void selectLanguage(code)}
        disabled={status.isLoading || download.isPending || docsBusy}
        options={APP_LANGUAGE_OPTIONS.map((option) => ({ code: option.id, label: option.label }))}
      />
      <p className="text-[0.625rem] text-[var(--muted-foreground)]">{t("settings.application.language.fallback")}</p>
      {(language !== "en" || download.isPending) && (
        <button
          type="button"
          onClick={() => void selectLanguage(language, true)}
          disabled={download.isPending || docsBusy}
          className={SETTINGS_BUTTON_CLASS}
        >
          {download.isPending ? (
            <Loader2 size="0.75rem" className="animate-spin" />
          ) : status.data?.installed.includes(language) ? (
            <RefreshCw size="0.75rem" />
          ) : (
            <Download size="0.75rem" />
          )}
          {t(
            download.isPending ? "settings.application.language.downloading" : "settings.application.language.refresh",
          )}
        </button>
      )}
    </div>
  );
}

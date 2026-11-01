import { useMemo } from "react";
import { AlertTriangle, BookOpen, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError } from "../../../lib/api-client";
import {
  DOCS_FOLLOW_APP,
  useDocsLanguage,
  useDocsLanguageBusy,
  useDocsLanguageChoice,
  useFixDocsLanguage,
  useSetDocsLanguage,
} from "../../../hooks/use-docs-language";
import { useUIStore } from "../../../stores/ui.store";
import { LanguagePicker } from "../../ui/LanguagePicker";
import { SETTINGS_BUTTON_CLASS } from "./SettingControls";

/**
 * Switch the help pages to a language. The server serves one pack at a time, so a pack that is not installed
 * downloads and replaces the current one (the same call the onboarding tour makes). `follow` is the stored
 * "same as app language" choice that goes with the switch, or null to keep an explicit choice and only pin
 * "follows" when nothing is stored (the download of the follow target); it is put back if the switch fails, so
 * a failed download leaves the picker where it was. `quiet` leaves the success toast to the caller, which
 * words it together with its own change; failures always toast.
 */
export function useDocsLanguageSwitch() {
  const { t } = useTranslation();
  const available = useDocsLanguage().data?.available;
  const setFollows = useUIStore((s) => s.setDocsFollowsApp);
  const pinFollowing = useUIStore((s) => s.pinDocsFollowing);
  const setDocsLanguage = useSetDocsLanguage();

  return async (code: string, follow: boolean | null, quiet = false) => {
    const info = available?.find((option) => option.code === code);
    const downloads = code !== "en" && !(info?.installed ?? false);
    const previous = useUIStore.getState().docsFollowsApp;
    if (follow === null) pinFollowing();
    else setFollows(follow);
    if (downloads && !quiet) {
      toast.info(t("settings.application.docsLanguage.downloadingLanguage", { language: info?.label ?? code }));
    }
    try {
      const result = await setDocsLanguage.mutateAsync(code);
      const label = result.available.find((option) => option.code === result.active)?.label ?? result.active;
      if (!quiet) {
        toast.success(
          t(
            downloads
              ? "settings.application.docsLanguage.switchedDownloaded"
              : "settings.application.docsLanguage.switched",
            { language: label },
          ),
        );
      }
      return { ok: true, downloaded: downloads, label };
    } catch (err) {
      setFollows(previous);
      const reason =
        err instanceof ApiError && err.status === 409
          ? t("settings.application.docsLanguage.installInProgress")
          : err instanceof Error
            ? err.message
            : String(err);
      toast.error(t("settings.application.docsLanguage.switchFailed", { reason }));
      return { ok: false, downloaded: downloads, label: info?.label ?? code };
    }
  };
}

/**
 * Help-pages language state and actions, shared by the Settings row and the help viewer's header so both
 * show the same picker. Picking applies at once: "Same as app language" follows the app language, a
 * language keeps the pick explicit.
 */
function useDocsLanguageControl() {
  const { t } = useTranslation();
  const { status, following, active, wanted, followTarget } = useDocsLanguageChoice();
  const setFollows = useUIStore((s) => s.setDocsFollowsApp);
  const switchTo = useDocsLanguageSwitch();
  const fixDocsLanguage = useFixDocsLanguage();
  const { busy, switching, fixing, pendingTarget } = useDocsLanguageBusy();
  const available = status.data?.available;

  const options = useMemo(
    () => [
      {
        code: DOCS_FOLLOW_APP,
        label: t("settings.application.docsLanguage.sameAsApp"),
        englishLabel: t("settings.application.docsLanguage.sameAsApp"),
      },
      ...(available?.length ? available : [{ code: "en", label: "English" }]),
    ],
    [available, t],
  );

  const choose = (value: string) => {
    const follow = value === DOCS_FOLLOW_APP;
    const target = follow ? followTarget : value;
    if (target === active) setFollows(follow);
    else void switchTo(target, follow);
  };

  const fix = async () => {
    try {
      const result = await fixDocsLanguage.mutateAsync();
      // Say what the fix actually did: re-downloaded the pack, reset to English, or just swept leftovers.
      const message = !result.repaired
        ? "settings.application.docsLanguage.healthy"
        : result.actions.includes("reinstalled-pack")
          ? "settings.application.docsLanguage.fixedReinstalled"
          : result.actions.some((action) => action.startsWith("reset"))
            ? "settings.application.docsLanguage.fixed"
            : "settings.application.docsLanguage.fixedCleaned";
      toast.success(t(message));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const wantedInfo = available?.find((option) => option.code === wanted);
  return {
    options,
    // While an explicit pick downloads, the picker shows it, not the pack that is still being served.
    value: following ? DOCS_FOLLOW_APP : (pendingTarget ?? active),
    loading: status.isLoading,
    busy,
    switching,
    fixing,
    progress: status.data?.install ?? null,
    integrityOk: status.data ? status.data.integrity.ok : true,
    // The wanted pack is not the one being served: not downloaded yet, or the last download failed.
    needsDownload: wanted !== active,
    willDownload: wanted !== "en" && !(wantedInfo?.installed ?? false),
    wantedLabel: wantedInfo?.label ?? wanted,
    activeLabel: available?.find((option) => option.code === active)?.label ?? active,
    choose,
    download: () => void switchTo(wanted, null),
    fix: () => void fix(),
  };
}

type DocsLanguageControl = ReturnType<typeof useDocsLanguageControl>;

/** Brings the served pack to the wanted language: a download that replaces the pack, or a plain switch when it is installed. */
function DocsSwitchButton({ control }: { control: DocsLanguageControl }) {
  const { t } = useTranslation();
  const progress = control.progress;
  return (
    <button type="button" onClick={control.download} disabled={control.busy} className={SETTINGS_BUTTON_CLASS}>
      {control.switching ? (
        <>
          <Loader2 size="0.75rem" className="animate-spin" />
          {progress && progress.filesTotal > 0
            ? t("settings.application.docsLanguage.downloading", {
                done: progress.filesDone,
                total: progress.filesTotal,
              })
            : t("settings.application.docsLanguage.switching")}
        </>
      ) : (
        <>
          <BookOpen size="0.75rem" />
          {control.willDownload
            ? t("settings.application.docsLanguage.downloadAndReplace")
            : t("settings.application.docsLanguage.switchTo", { language: control.wantedLabel })}
        </>
      )}
    </button>
  );
}

/** The "Help pages language" row: label, hint and picker. */
export function DocsLanguagePicker({
  id,
  label,
  showHint = true,
  anchorId,
}: {
  id: string;
  label: string;
  showHint?: boolean;
  anchorId?: string;
}) {
  const { t } = useTranslation();
  const control = useDocsLanguageControl();
  return (
    <div id={anchorId} className="flex min-w-0 scroll-mt-3 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <LanguagePicker
        id={id}
        label={label}
        value={control.value}
        onChange={control.choose}
        disabled={control.loading || control.busy}
        options={control.options}
      />
      {showHint ? (
        <p className="text-[0.625rem] text-[var(--muted-foreground)]">{t("settings.application.docsLanguage.hint")}</p>
      ) : null}
      {/* Following an app language that has a pack: the pages stay in the old language until it is brought over. */}
      {control.needsDownload || control.switching ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {control.switching ? null : (
            <p className="text-[0.625rem] text-[var(--muted-foreground)]">
              {t("settings.application.docsLanguage.stillIn", { language: control.activeLabel })}
            </p>
          )}
          <DocsSwitchButton control={control} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The help viewer's header strip: the language picker plus the two repair actions. The switch action shows
 * while the language the help pages should be in is not the one being served; "Fix documentation" checks the
 * installed pack and repairs it. Each action sits in its own wrapper so a search jump finds and focuses it.
 */
export function DocsViewerLanguageStrip() {
  const { t } = useTranslation();
  const control = useDocsLanguageControl();
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-x-3 gap-y-2" data-component="DocsViewerLanguageStrip">
      <div className="flex min-w-[10rem] max-w-xs flex-1 flex-col gap-1">
        <label htmlFor="docs-viewer-language" className="text-[0.6875rem] font-medium">
          {t("settings.application.docsLanguage.stripLabel")}
        </label>
        <LanguagePicker
          id="docs-viewer-language"
          label={t("settings.application.docsLanguage.stripLabel")}
          value={control.value}
          onChange={control.choose}
          disabled={control.loading || control.busy}
          options={control.options}
        />
      </div>
      <span id="settings-control-docs-download-replace" className="inline-flex">
        {control.needsDownload || control.switching ? <DocsSwitchButton control={control} /> : null}
      </span>
      <span id="settings-control-docs-fix" className="inline-flex">
        <button type="button" onClick={control.fix} disabled={control.busy} className={SETTINGS_BUTTON_CLASS}>
          {control.fixing ? (
            <>
              <Loader2 size="0.75rem" className="animate-spin" />
              {t("settings.application.docsLanguage.fixing")}
            </>
          ) : (
            <>
              <Wrench size="0.75rem" />
              {t("settings.application.docsLanguage.fix")}
            </>
          )}
        </button>
      </span>
      {!control.integrityOk ? (
        <p className="flex w-full items-start gap-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">
          <AlertTriangle size="0.8125rem" className="mt-0.5 shrink-0 text-amber-500" />
          {t("settings.application.docsLanguage.fixNeeded")}
        </p>
      ) : null}
    </div>
  );
}

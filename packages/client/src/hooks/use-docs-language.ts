// ──────────────────────────────────────────────
// React Query: Documentation language (docs/i18n/<code> trees)
// ──────────────────────────────────────────────
import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_DOCS_LANGUAGE, docsFollowsAppLanguage, matchDocsLanguage } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { useUIStore } from "../stores/ui.store";

/**
 * Root of every docs query key (mirrors docsKeys.all in use-docs.ts, duplicated
 * here to avoid an import cycle: use-docs reads the active language from this file).
 */
const DOCS_QUERY_ROOT = ["docs"] as const;

export interface DocLanguageInfo {
  code: string;
  /** Native name shown in pickers (e.g. "Español") */
  label: string;
  englishLabel: string;
  /** Whether this language's pack is downloaded ("en" is built-in, always true) */
  installed: boolean;
  /** English doc paths covered by this language's installed pack */
  translated: number;
  total: number;
}

export interface DocsPackInstallProgress {
  language: string;
  phase: "manifest" | "downloading" | "finalizing";
  filesDone: number;
  filesTotal: number;
}

export interface DocsLanguageStatus {
  /** Language the server is serving right now */
  active: string;
  /** True once the user has explicitly stored a choice (even a broken one) */
  configured: boolean;
  available: DocLanguageInfo[];
  /** Progress of an in-flight pack download, or null */
  install: DocsPackInstallProgress | null;
  integrity: {
    ok: boolean;
    unknownLanguage: boolean;
    activeRootMissing: boolean;
    packIncomplete: boolean;
    leftovers: boolean;
  };
}

export interface DocsLanguageFixResult extends DocsLanguageStatus {
  repaired: boolean;
  actions: string[];
}

export const docsLanguageKeys = {
  status: () => [...DOCS_QUERY_ROOT, "language"] as const,
};

const SET_DOCS_LANGUAGE_MUTATION_KEY = [...DOCS_QUERY_ROOT, "language", "set"] as const;
const FIX_DOCS_LANGUAGE_MUTATION_KEY = [...DOCS_QUERY_ROOT, "language", "fix"] as const;
/** Prefix of both docs-language mutation keys: either one running means the pack on disk is changing. */
const DOCS_LANGUAGE_MUTATIONS_KEY = [...DOCS_QUERY_ROOT, "language"] as const;

export function useDocsLanguage(enabled = true) {
  // The switch PUT blocks server-side for the whole pack download and can't
  // update the status itself; `install` starts as null, so polling must
  // bootstrap from this client's pending switch mutation, not from the data.
  const switching = useIsMutating({ mutationKey: SET_DOCS_LANGUAGE_MUTATION_KEY }) > 0;
  return useQuery({
    queryKey: docsLanguageKeys.status(),
    queryFn: () => api.get<DocsLanguageStatus>("/docs/language"),
    enabled,
    staleTime: 30_000,
    refetchInterval: (query) => (switching || query.state.data?.install ? 1_000 : false),
    // A background download started elsewhere (onboarding) must surface when a
    // consumer mounts, even if a <30s-old cached status still says install:null.
    refetchOnMount: "always",
  });
}

/** Switching invalidates every docs query so the viewer refetches in the new language. */
export function useSetDocsLanguage() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: SET_DOCS_LANGUAGE_MUTATION_KEY,
    mutationFn: (language: string) => api.put<DocsLanguageStatus>("/docs/language", { language }),
    onSuccess: (status) => {
      qc.setQueryData(docsLanguageKeys.status(), status);
      void qc.invalidateQueries({ queryKey: DOCS_QUERY_ROOT });
    },
  });
}

/** Failsafe: resets a dangling/corrupt stored language back to English on the server. */
export function useFixDocsLanguage() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: FIX_DOCS_LANGUAGE_MUTATION_KEY,
    mutationFn: () => api.post<DocsLanguageFixResult>("/docs/language/fix", {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DOCS_QUERY_ROOT });
    },
  });
}

/**
 * What the docs-language mutations are doing app-wide (not per component), so every picker and action that
 * would race the one pack on disk disables together: a switch/download, a fix, and the target of a pending switch.
 */
export function useDocsLanguageBusy() {
  const busy = useIsMutating({ mutationKey: DOCS_LANGUAGE_MUTATIONS_KEY }) > 0;
  const switching = useIsMutating({ mutationKey: SET_DOCS_LANGUAGE_MUTATION_KEY }) > 0;
  const fixing = useIsMutating({ mutationKey: FIX_DOCS_LANGUAGE_MUTATION_KEY }) > 0;
  const pendingTargets = useMutationState({
    filters: { mutationKey: SET_DOCS_LANGUAGE_MUTATION_KEY, status: "pending" },
    select: (mutation) => mutation.state.variables as string,
  });
  return { busy, switching, fixing, pendingTarget: pendingTargets.at(-1) };
}

/** Picker value for "Same as app language"; never a docs-pack code. */
export const DOCS_FOLLOW_APP = "same-as-app";

/**
 * Help-pages language choice. While following, the wanted pack is the one that matches the
 * app language (English when none does). With no stored choice, an explicit language already
 * on the server stays explicit, so existing installs keep reading what they picked.
 */
export function useDocsLanguageChoice(enabled = true) {
  const status = useDocsLanguage(enabled);
  const appLanguage = useUIStore((s) => s.language);
  const stored = useUIStore((s) => s.docsFollowsApp);
  const data = status.data;
  const following = docsFollowsAppLanguage(stored, data?.configured ?? false);
  const active = data?.active ?? DEFAULT_DOCS_LANGUAGE;
  const followTarget =
    matchDocsLanguage(appLanguage, data?.available.map((option) => option.code) ?? []) ?? DEFAULT_DOCS_LANGUAGE;
  const wanted = following ? followTarget : active;
  return { status, following, active, wanted, followTarget };
}

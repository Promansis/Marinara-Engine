export const LTM_AUTO_APPLY_LOW_RISK_STORAGE_KEY = "ltm:auto-apply-low-risk";

export function readRememberedLtmAutoApplyLowRisk() {
  try {
    return window.localStorage.getItem(LTM_AUTO_APPLY_LOW_RISK_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function rememberLtmAutoApplyLowRisk(value: boolean) {
  try {
    window.localStorage.setItem(LTM_AUTO_APPLY_LOW_RISK_STORAGE_KEY, String(value));
  } catch {
    // Ignore unavailable or full localStorage; the in-memory toggle still works.
  }
}

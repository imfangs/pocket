import configuredAnalytics from "../config/usage-analytics.json";
import { currentMachineId } from "./machineScope";
import { createUsageJournal, type UsageProperties } from "./usageJournal";
import type { PostHog } from "posthog-js";
import { CLIENT_VERSION } from "./clientVersion";
const config: {enabled:boolean;projectKey:string;apiHost:string;uiHost:string;origins:string[];environment:string} = configuredAnalytics;

let active = false, initialized = false, generation = 0, sdk: PostHog | null = null;
const pending: { event: string; properties: UsageProperties; timestamp: Date }[] = [];
export function usageConfigured() {
  return config.enabled && /^phc_[A-Za-z0-9]+$/.test(config.projectKey) &&
    typeof location !== "undefined" && config.origins.includes(location.origin);
}
function capture(event: string, properties: UsageProperties): boolean {
  if (!active) return false;
  const record = { event, properties: { ...properties, machine_id: currentMachineId(),
    environment: config.environment,
    frontend_version: CLIENT_VERSION,
    display_mode: window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser",
  }, timestamp: new Date() };
  if (sdk) sdk.capture(event, record.properties, { timestamp: record.timestamp });
  else { if (pending.length === 100) pending.shift(); pending.push(record); }
  return true;
}
export const usage = createUsageJournal({ capture });

export function feedbackReplayContext(): { distinctId?: string; sessionId?: string; replayUrl?: string } {
  if (!sdk || !active) return {};
  try { return { distinctId: sdk.get_distinct_id(), sessionId: sdk.get_session_id(), replayUrl: sdk.get_session_replay_url({ withTimestamp: true }) }; }
  catch { return {}; }
}

/** Only the authenticated application owns this lifecycle. Loading/blocked SDKs cannot block Pocket. */
export function startUsageAnalytics() {
  if (!usageConfigured()) return () => {};
  const ownGeneration = ++generation;
  active = true;
  usage.enable(true, document.visibilityState !== "hidden");
  const visibility = () => usage.visibility(document.visibilityState !== "hidden");
  const pagehide = (event: PageTransitionEvent) => { usage.event("pocket_page_hidden", { persisted: event.persisted }); usage.visibility(false); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("pageshow", visibility);
  // Ship the versioned recorder with the lazy SDK chunk instead of loading it later from another CDN.
  void import("posthog-js/full/no-external").then(({ default: posthog }) => {
    if (!active || generation !== ownGeneration) return;
    if (!initialized) posthog.init(config.projectKey, {
      api_host: config.apiHost, ui_host: config.uiHost,
      autocapture: false, capture_pageview: false, capture_pageleave: false,
      capture_exceptions: false, capture_performance: false,
      disable_surveys: true, disable_product_tours: true,
      // Isolated verification builds are explicitly tagged; production keeps bot filtering.
      opt_out_useragent_filter: config.environment === "qa",
      person_profiles: "never", persistence: "localStorage",
      disable_session_recording: false,
      enable_recording_console_log: false,
      session_recording: { recordHeaders: false, recordBody: false, maskAllInputs: true, maskTextSelector: "*" },
    });
    initialized = true;
    posthog.opt_in_capturing({ captureEventName: false });
    posthog.startSessionRecording();
    sdk = posthog;
    for (const item of pending.splice(0)) sdk.capture(item.event, item.properties, { timestamp: item.timestamp });
    usage.event("$pageview");
    usage.event("pocket_usage_started");
  }).catch(() => { if (generation === ownGeneration) { active = false; pending.length = 0; usage.enable(false); } });
  return () => {
    if (generation !== ownGeneration) return;
    active = false; generation++; pending.length = 0;
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("pageshow", visibility);
    usage.enable(false);
    try { sdk?.stopSessionRecording(); sdk?.opt_out_capturing(); } catch { /* Closing Pocket must remain independent of analytics. */ }
    sdk = null;
  };
}

export function recordUsageFailure(operation: string, failure: unknown, threadId: string) {
  const value = failure as { status?: number; code?: string; name?: string } | null;
  if (value?.name === "AbortError") return;
  usage.event("pocket_request_failed", { operation, thread_id: threadId, status: value?.status ?? null,
    error_code: value?.code && /^[a-z0-9_]{1,80}$/i.test(value.code) ? value.code : "request_failed" });
}

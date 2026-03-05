/**
 * content.ts — runs in ISOLATED world (Chrome extension context).
 *
 * Sole responsibility: relay window.postMessage events from inject.ts
 * (which runs in MAIN world) to the background service worker via
 * chrome.runtime.sendMessage.
 *
 * No DOM manipulation or direct page interaction here.
 */

import type { InjectMessage } from "./types";

window.addEventListener("message", (event: MessageEvent) => {
  // Only accept messages from the same frame
  if (event.source !== window) return;

  const msg = event.data as InjectMessage | null;
  if (!msg || msg.source !== "KT_INJECT") return;

  // Forward to background; ignore connection errors if background is sleeping
  chrome.runtime.sendMessage({
    type: msg.type,
    timestamp: msg.timestamp,
    data: msg.data,
  }).catch(() => {
    // Background service worker may be inactive — message lost, non-critical
  });
});

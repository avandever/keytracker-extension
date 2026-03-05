/**
 * background.ts — Manifest V3 service worker.
 *
 * Responsibilities:
 *  - Receive events relayed from content.ts
 *  - Accumulate them into GameSession objects (keyed by Crucible game UUID)
 *  - Detect game start (first gamestate event) and game end (KT_GAME_END)
 *  - Respond to popup requests: GET_STATE, DOWNLOAD_SESSION, DOWNLOAD_ALL,
 *    CLEAR_COMPLETED, CLEAR_ALL
 *  - Update the extension badge with session status
 */

import type {
  GameSession,
  SessionEvent,
  BackgroundState,
  InjectEventType,
} from "./types";

// ─── State ──────────────────────────────────────────────────────────────────

let currentSession: GameSession | null = null;
const completedSessions: GameSession[] = [];

function makeSession(): GameSession {
  return {
    sessionId: `kt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    startTime: Date.now(),
    events: [],
    gamestateSnapshots: [],
  };
}

// ─── Session Management ──────────────────────────────────────────────────────

function ensureSession(): GameSession {
  if (!currentSession) {
    currentSession = makeSession();
    setBadge("●", "#1565c0"); // blue: in progress
  }
  return currentSession;
}

function finalizeSession(reason: string): void {
  if (!currentSession) return;
  currentSession.endTime = Date.now();
  currentSession.gameEndReason = reason;
  completedSessions.push(currentSession);
  currentSession = null;
  setBadge(`${completedSessions.length}`, "#2e7d32"); // green: completed
}

// ─── Badge Helper ────────────────────────────────────────────────────────────

function setBadge(text: string, color: string): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

function handleInjectEvent(
  type: InjectEventType,
  timestamp: number,
  data: unknown
): void {
  const event: SessionEvent = { type, timestamp, data };

  switch (type) {
    case "KT_INJECT_READY":
      // Inject script loaded — wait for first gamestate before starting session
      break;

    case "KT_WS_OPEN":
      // WebSocket opened — may be the game socket or lobby socket
      break;

    case "KT_GAMESTATE": {
      const session = ensureSession();
      session.events.push(event);
      session.gamestateSnapshots.push(data);

      // Try to extract crucible game ID from gamestate payload
      const gs = data as Record<string, unknown>;
      const gsGame = gs?.game as Record<string, unknown> | undefined;
      const gameId = gs?.id ?? gs?.gameId ?? gsGame?.id;
      if (typeof gameId === "string" && !session.crucibleGameId) {
        session.crucibleGameId = gameId;
      }

      // Extract player names from first gamestate
      if (!session.player1 && Array.isArray(gs?.players)) {
        const players = gs.players as Array<Record<string, unknown>>;
        if (players[0]) session.player1 = String(players[0].name ?? players[0].username ?? "");
        if (players[1]) session.player2 = String(players[1].name ?? players[1].username ?? "");
      }
      break;
    }

    case "KT_GAME_END": {
      const session = ensureSession();
      session.events.push(event);
      const end = data as Record<string, unknown>;
      session.winner = String(end?.winner ?? "");
      finalizeSession("win_detected");
      break;
    }

    case "KT_REDUX_STATE": {
      // Only add to session if one is already active
      if (currentSession) {
        currentSession.events.push(event);
        // Extract game ID from Redux currentGame if not already set
        const state = data as Record<string, unknown>;
        const cg = state?.currentGame as Record<string, unknown>;
        const gameId = cg?.id ?? cg?.gameId;
        if (typeof gameId === "string" && !currentSession.crucibleGameId) {
          currentSession.crucibleGameId = gameId;
        }
      }
      break;
    }

    case "KT_STORE_FOUND":
    case "KT_SOCKET_EVENT":
    case "KT_GAME_CHAT":
    case "KT_WS_CLOSE":
      if (currentSession) {
        currentSession.events.push(event);
      }
      break;
  }
}

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: Record<string, unknown>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void
  ) => {
    const { type } = message;

    // ── Inject events relayed by content.ts ──
    if (
      typeof type === "string" &&
      (type as string).startsWith("KT_")
    ) {
      handleInjectEvent(
        type as InjectEventType,
        (message.timestamp as number) ?? Date.now(),
        message.data
      );
      sendResponse({ ok: true });
      return false; // synchronous response
    }

    // ── Popup requests ──
    if (type === "GET_STATE") {
      const state: BackgroundState = {
        currentSession,
        completedSessions: [...completedSessions],
      };
      sendResponse(state);
      return false;
    }

    if (type === "DOWNLOAD_SESSION") {
      const id = message.sessionId as string;
      const session =
        completedSessions.find((s) => s.sessionId === id) ??
        (currentSession?.sessionId === id ? currentSession : null);
      sendResponse({ session });
      return false;
    }

    if (type === "DOWNLOAD_ALL") {
      const all = currentSession
        ? [...completedSessions, currentSession]
        : [...completedSessions];
      sendResponse({ sessions: all });
      return false;
    }

    if (type === "CLEAR_COMPLETED") {
      completedSessions.length = 0;
      if (!currentSession) setBadge("", "#666666");
      sendResponse({ ok: true });
      return false;
    }

    if (type === "CLEAR_ALL") {
      completedSessions.length = 0;
      currentSession = null;
      setBadge("", "#666666");
      sendResponse({ ok: true });
      return false;
    }

    return false;
  }
);

// ─── Init ─────────────────────────────────────────────────────────────────────

setBadge("", "#666666"); // grey: idle

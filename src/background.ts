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

// After a game ends, ignore new gamestate events for this many ms.
// Post-game lobby states keep arriving from the server for ~10s.
const POST_GAME_COOLDOWN_MS = 20_000;
let cooldownUntil = 0;

function ensureSession(): GameSession | null {
  if (Date.now() < cooldownUntil) return null; // post-game cooldown
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
  cooldownUntil = Date.now() + POST_GAME_COOLDOWN_MS;
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
      if (!session) break; // post-game cooldown — ignore stale server states

      session.events.push(event);
      session.gamestateSnapshots.push(data);

      // Crucible gamestate: players is a dict keyed by username, winner is a list
      const gs = data as Record<string, unknown>;

      // Extract player names from players dict (keys are usernames)
      if (!session.player1) {
        const players = gs?.players;
        if (players && typeof players === "object" && !Array.isArray(players)) {
          const names = Object.keys(players as Record<string, unknown>);
          if (names[0]) session.player1 = names[0];
          if (names[1]) session.player2 = names[1];
        }
      }
      break;
    }

    case "KT_GAME_END": {
      const session = ensureSession();
      if (!session) break; // duplicate end event during cooldown
      session.events.push(event);
      const end = data as Record<string, unknown>;
      session.winner = String(end?.winner ?? "");
      finalizeSession("win_detected");
      break;
    }

    case "KT_SOCKET_EVENT": {
      // Extract crucible game ID from updategame/newgame lobby events
      const ev = data as Record<string, unknown>;
      const extractedId = ev?.extractedGameId;
      if (typeof extractedId === "string") {
        if (currentSession && !currentSession.crucibleGameId) {
          // Active session — assign directly
          currentSession.crucibleGameId = extractedId;
        } else if (!currentSession && completedSessions.length > 0) {
          // Post-game: retroactively patch the last completed session
          const last = completedSessions[completedSessions.length - 1];
          if (!last.crucibleGameId) {
            last.crucibleGameId = extractedId;
          }
        }
      }
      if (currentSession) {
        currentSession.events.push(event);
      }
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
    case "KT_GAME_CHAT":
    case "KT_WS_OPEN":
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

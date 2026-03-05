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

// After a game ends, block new sessions with the same player set until a
// `handoff` socket event arrives. `handoff` fires exactly once per game when
// the client is handed off from the lobby server to the game server — it does
// NOT fire during post-game lobby browsing or rematch dialogs.
// For a new opponent, the guard is cleared immediately (different player set).
let postGamePlayerSet: Set<string> | null = null;
let awaitingHandoff = false;

function ensureSession(playerNames?: string[]): GameSession | null {
  if (awaitingHandoff && playerNames && playerNames.length > 0) {
    const sameGame =
      postGamePlayerSet !== null &&
      playerNames.length === postGamePlayerSet.size &&
      playerNames.every((n) => postGamePlayerSet!.has(n));
    if (sameGame) return null; // post-game / rematch-dialog state, no handoff yet
    // Different players → new opponent, no need to wait for handoff
    postGamePlayerSet = null;
    awaitingHandoff = false;
  }
  if (!currentSession) {
    currentSession = makeSession();
    setBadge("●", "#1565c0"); // blue: in progress
  }
  return currentSession;
}

function clearPostGameGuard(): void {
  postGamePlayerSet = null;
  awaitingHandoff = false;
}

function finalizeSession(reason: string): void {
  if (!currentSession) return;
  const names = [currentSession.player1, currentSession.player2].filter(
    Boolean
  ) as string[];
  postGamePlayerSet = names.length > 0 ? new Set(names) : null;
  awaitingHandoff = postGamePlayerSet !== null;

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
      // Crucible gamestate: players is a dict keyed by username, winner is a list
      const gs = data as Record<string, unknown>;
      const playersDict = gs?.players;
      const playerNames =
        playersDict &&
        typeof playersDict === "object" &&
        !Array.isArray(playersDict)
          ? Object.keys(playersDict as Record<string, unknown>)
          : [];

      const session = ensureSession(playerNames);
      if (!session) break; // post-game guard — same players as finished game

      session.events.push(event);
      session.gamestateSnapshots.push(data);

      if (!session.player1 && playerNames[0]) session.player1 = playerNames[0];
      if (!session.player2 && playerNames[1]) session.player2 = playerNames[1];
      break;
    }

    case "KT_GAME_END": {
      const session = ensureSession();
      if (!session) break; // guard active — stale end event
      session.events.push(event);
      const end = data as Record<string, unknown>;
      session.winner = String(end?.winner ?? "");
      finalizeSession("win_detected");
      break;
    }

    case "KT_SOCKET_EVENT": {
      const ev = data as Record<string, unknown>;

      // handoff fires exactly once per game when the client's socket is handed
      // off from lobby server to game server. It's the definitive signal that
      // a NEW game has started — safe to clear the post-game guard here.
      if (ev?.eventName === "handoff") {
        clearPostGameGuard();
      }

      // Extract crucible game ID from updategame/newgame lobby events
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

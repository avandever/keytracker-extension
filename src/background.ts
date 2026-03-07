/**
 * background.ts — Manifest V3 service worker.
 *
 * Responsibilities:
 *  - Receive events relayed from content.ts
 *  - Accumulate them into GameSession objects (keyed by Crucible game UUID)
 *  - Detect game start (first gamestate event) and game end (KT_GAME_END)
 *  - Respond to popup requests: GET_STATE, DOWNLOAD_SESSION, DOWNLOAD_ALL,
 *    CLEAR_COMPLETED, CLEAR_ALL, SUBMIT_SESSION, GET_SETTINGS, SAVE_SETTINGS
 *  - Update the extension badge with session status
 *  - Auto-submit completed sessions to the tracker (if enabled)
 */

import type {
  GameSession,
  SessionEvent,
  BackgroundState,
  InjectEventType,
  Settings,
  DebugLogEntry,
} from "./types";

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  trackerUrl: "https://tracker.ancientbearrepublic.com",
  autoSubmit: false,
  debugMode: false,
};

let settings: Settings = { ...DEFAULT_SETTINGS };

// Load persisted settings at startup
chrome.storage.sync.get(["settings"]).then((result) => {
  if (result.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(result.settings as Partial<Settings>) };
  }
});

// ─── Debug Log ───────────────────────────────────────────────────────────────

const DEBUG_LOG_MAX = 500;
const debugLog: DebugLogEntry[] = [];

function dlog(type: string, detail: string, guardBlocked: boolean): void {
  if (!settings.debugMode) return;
  debugLog.push({ ts: Date.now(), type, detail, guardBlocked });
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
}

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

// After a game ends, block new sessions with the same player set for a
// grace period (POST_GAME_GUARD_MS). `handoff` never reliably fires, so we
// use a time-based expiry instead. For a different opponent the guard clears
// immediately (different player set = new opponent, no risk of double-session).
const POST_GAME_GUARD_MS = 90_000; // 90 seconds — post-game gamestates last ~55s

let postGamePlayerSet: Set<string> | null = null;
let postGameGuardExpiry: number | null = null;

function guardActive(): boolean {
  if (postGamePlayerSet === null) return false;
  if (postGameGuardExpiry !== null && Date.now() > postGameGuardExpiry) {
    clearPostGameGuard();
    return false;
  }
  return true;
}

function ensureSession(playerNames?: string[]): GameSession | null {
  if (guardActive() && playerNames && playerNames.length > 0) {
    // Block only if EVERY player was in the previous game — handles partial
    // post-game gamestates (subset of players) while allowing new opponents
    // immediately (they introduce a player not in the post-game set).
    const isRematchOrPostGame = playerNames.every((n) => postGamePlayerSet!.has(n));
    if (isRematchOrPostGame) return null; // still in post-game / rematch context
    // At least one new player → new opponent, clear immediately
    clearPostGameGuard();
  }
  if (!currentSession) {
    currentSession = makeSession();
    setBadge("●", "#1565c0"); // blue: in progress
  }
  return currentSession;
}

function clearPostGameGuard(): void {
  postGamePlayerSet = null;
  postGameGuardExpiry = null;
}

// ─── Log Builder ─────────────────────────────────────────────────────────────

// Construct a minimal synthetic log from known game data.
// The tracker's log_to_game() parser requires:
//   1. "{player} brings {deck} to The Crucible" × 2  (PLAYER_DECK_MATCHER)
//   2. "{player} won the flip"                         (FIRST_PLAYER_MATCHER)
//   3. "{winner} has won the game"                     (WIN_MATCHER)
function buildLog(session: GameSession): string {
  const p1 = session.player1 ?? "Player1";
  const p2 = session.player2 ?? "Player2";
  // If winner is "unknown" (e.g. player left before we resolved the name),
  // fall back to player1 — the log must name a known player.
  const rawWinner = session.winner ?? "";
  const winner = rawWinner && rawWinner !== "unknown" ? rawWinner : p1;
  // Use captured deck names when available so the backend can look up decks
  // by name in its local DB. Fall back to "UNSET" (sentinel that skips MV API
  // lookup) if we didn't capture the name.
  const d1 = session.player1DeckName ?? "UNSET";
  const d2 = session.player2DeckName ?? "UNSET";
  return [
    `${p1} brings ${d1} to The Crucible`,
    `${p2} brings ${d2} to The Crucible`,
    `${p1} won the flip`,
    `${winner} has won the game`,
  ].join("\n");
}

// ─── Submission ───────────────────────────────────────────────────────────────

async function doSubmit(session: GameSession): Promise<void> {
  const log = session.finalLog ?? buildLog(session);
  const body = new URLSearchParams();
  body.set("log", log);
  if (session.crucibleGameId) {
    body.set("crucible_game_id", session.crucibleGameId);
  }
  if (session.startTime) {
    body.set("date", new Date(session.startTime).toISOString());
  }

  // If we captured deck UUIDs from the DOM, pass them explicitly — more
  // reliable than name-based lookup from the log.
  const isP1Winner = session.winner === session.player1;
  const winnerDeckId = isP1Winner ? session.player1DeckId : session.player2DeckId;
  const loserDeckId = isP1Winner ? session.player2DeckId : session.player1DeckId;
  if (winnerDeckId) body.set("winner_deck_id", winnerDeckId);
  if (loserDeckId) body.set("loser_deck_id", loserDeckId);

  const url = `${settings.trackerUrl}/api/upload_log/v1`;
  const resp = await fetch(url, { method: "POST", body });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = (await resp.json()) as Record<string, unknown>;
  session.submittedAt = Date.now();
  if (typeof json.game_id === "number") {
    session.submittedGameId = json.game_id;
  }
}

// ─── Session Finalization ─────────────────────────────────────────────────────

function finalizeSession(reason: string): void {
  if (!currentSession) return;
  const names = [currentSession.player1, currentSession.player2].filter(
    Boolean
  ) as string[];
  postGamePlayerSet = names.length > 0 ? new Set(names) : null;
  postGameGuardExpiry = postGamePlayerSet !== null ? Date.now() + POST_GAME_GUARD_MS : null;

  currentSession.endTime = Date.now();
  currentSession.gameEndReason = reason;
  currentSession.finalLog = buildLog(currentSession);
  completedSessions.push(currentSession);
  currentSession = null;
  setBadge(`${completedSessions.length}`, "#2e7d32"); // green: completed

  if (settings.autoSubmit) {
    const justFinished = completedSessions[completedSessions.length - 1];
    doSubmit(justFinished).catch((err: Error) => {
      justFinished.submitError = err.message;
    });
  }
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

      const gsWinner = gs?.winner;
      const hasWinner = Array.isArray(gsWinner) && gsWinner.length > 0;
      const session = ensureSession(playerNames);
      const blocked = !session;
      dlog(
        "KT_GAMESTATE",
        `players=[${playerNames.join(",")}] winner=${hasWinner ? gsWinner[0] : "none"} ` +
          `guardActive=${guardActive()} postGameSet=[${postGamePlayerSet ? [...postGamePlayerSet].join(",") : ""}] expiresIn=${postGameGuardExpiry ? Math.round((postGameGuardExpiry - Date.now()) / 1000) + "s" : "none"}`,
        blocked
      );
      if (!session) break; // post-game guard — same players as finished game

      session.events.push(event);
      session.gamestateSnapshots.push(data);

      // Extract the crucible game ID from lobby-phase gamestates (before handoff).
      // The pre-game gamestate has a top-level `id` field that IS the game UUID.
      // We prefer this over the lobby socket `updategame` events, which broadcast
      // ALL active games and can accidentally pick up a different game's UUID.
      const gsGameId = gs?.id;
      if (typeof gsGameId === "string" && !session.crucibleGameId) {
        session.crucibleGameId = gsGameId;
      }

      const pd = playersDict as Record<string, Record<string, unknown>>;
      if (!session.player1 && playerNames[0]) {
        session.player1 = playerNames[0];
        // Extract deck name from player object: players[username].deck.name
        // (The deck object in lobby gamestates has name/selected/status but no UUID)
        const deck = pd[playerNames[0]]?.deck as Record<string, unknown> | undefined;
        const dname = deck?.name;
        if (typeof dname === "string") session.player1DeckName = dname;
      }
      if (!session.player2 && playerNames[1]) {
        session.player2 = playerNames[1];
        const deck = pd[playerNames[1]]?.deck as Record<string, unknown> | undefined;
        const dname = deck?.name;
        if (typeof dname === "string") session.player2DeckName = dname;
      }
      break;
    }

    case "KT_GAME_END": {
      const end = data as Record<string, unknown>;
      // Only finalize an existing session — never create one from a game-end event.
      // Stale end events (post-game lobby, "X has left") have no session to close.
      const blocked = !currentSession;
      dlog(
        "KT_GAME_END",
        `winner=${end?.winner} source=${end?.source} hasSession=${!blocked}`,
        blocked
      );
      if (!currentSession) break;
      currentSession.events.push(event);
      currentSession.winner = String(end?.winner ?? "");
      finalizeSession("win_detected");
      break;
    }

    case "KT_SOCKET_EVENT": {
      const ev = data as Record<string, unknown>;

      // handoff fires exactly once per game when the client's socket is handed
      // off from lobby server to game server. It's the definitive signal that
      // a NEW game has started — safe to clear the post-game guard here.
      if (ev?.eventName === "handoff") {
        // Belt-and-suspenders: clear guard early if handoff does fire.
        // In practice handoff doesn't appear to fire reliably; we use
        // time-based expiry (POST_GAME_GUARD_MS) as the primary mechanism.
        dlog("KT_SOCKET_EVENT", "handoff — clearing post-game guard early", false);
        clearPostGameGuard();
      } else {
        dlog(
          "KT_SOCKET_EVENT",
          `eventName=${ev?.eventName} extractedGameId=${ev?.extractedGameId ?? ""}`,
          false
        );
      }

      // Extract crucible game ID from updategame/newgame lobby events
      const extractedId = ev?.extractedGameId;
      if (typeof extractedId === "string") {
        if (currentSession && !currentSession.crucibleGameId) {
          // Active session — assign directly
          currentSession.crucibleGameId = extractedId;
        } else if (!currentSession && completedSessions.length > 0) {
          // Post-game: retroactively patch the last completed session,
          // but only if it looks like a real game (both players known).
          const last = completedSessions[completedSessions.length - 1];
          if (!last.crucibleGameId && last.player1 && last.player2) {
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

    case "KT_DECK_LINK": {
      // Deck UUID extracted from DOM "brings [deck] to The Crucible" anchor tag.
      // Associate with whichever player matches, in either active or the most
      // recent completed session (link may fire slightly after game end event).
      const link = data as Record<string, unknown>;
      const deckId = typeof link?.deckId === "string" ? link.deckId : null;
      const playerName = typeof link?.playerName === "string" ? link.playerName : null;
      dlog(
        "KT_DECK_LINK",
        `player=${playerName ?? "?"} deckId=${deckId ?? "?"}`,
        false
      );
      if (deckId) {
        const target =
          currentSession ??
          (completedSessions.length > 0
            ? completedSessions[completedSessions.length - 1]
            : null);
        if (target) {
          if (playerName && playerName === target.player1 && !target.player1DeckId) {
            target.player1DeckId = deckId;
            if (currentSession) currentSession.events.push(event);
          } else if (playerName && playerName === target.player2 && !target.player2DeckId) {
            target.player2DeckId = deckId;
            if (currentSession) currentSession.events.push(event);
          } else if (!playerName) {
            // No player context — fill in whichever slot is empty
            if (!target.player1DeckId) {
              target.player1DeckId = deckId;
            } else if (!target.player2DeckId) {
              target.player2DeckId = deckId;
            }
            if (currentSession) currentSession.events.push(event);
          }
        }
      }
      break;
    }

    case "KT_STORE_FOUND":
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

    // ── SUBMIT_SESSION (async) ──
    if (type === "SUBMIT_SESSION") {
      const id = message.sessionId as string;
      const session =
        completedSessions.find((s) => s.sessionId === id) ??
        (currentSession?.sessionId === id ? currentSession : null);
      if (!session) {
        sendResponse({ ok: false, error: "Session not found" });
        return false;
      }
      // Clear previous error so UI shows fresh attempt
      session.submitError = undefined;
      doSubmit(session)
        .then(() =>
          sendResponse({ ok: true, submittedGameId: session.submittedGameId })
        )
        .catch((err: Error) => {
          session.submitError = err.message;
          sendResponse({ ok: false, error: err.message });
        });
      return true; // keep channel open for async response
    }

    // ── Popup requests (sync) ──
    if (type === "GET_STATE") {
      const state: BackgroundState = {
        currentSession,
        completedSessions: [...completedSessions],
        settings,
      };
      sendResponse(state);
      return false;
    }

    if (type === "GET_SETTINGS") {
      sendResponse({ ...settings });
      return false;
    }

    if (type === "SAVE_SETTINGS") {
      const newSettings = message.settings as Settings;
      settings = { ...DEFAULT_SETTINGS, ...newSettings };
      chrome.storage.sync.set({ settings });
      sendResponse({ ok: true });
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

    if (type === "GET_DEBUG_LOG") {
      sendResponse({ entries: [...debugLog] });
      return false;
    }

    if (type === "CLEAR_DEBUG_LOG") {
      debugLog.length = 0;
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

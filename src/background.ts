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
  TurnTimingEntry,
} from "./types";

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  trackerUrl: "https://tracker.ancientbearrepublic.com",
  tcoUsername: "",
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

// ─── Session Persistence ─────────────────────────────────────────────────────
//
// MV3 service workers are terminated whenever Chrome decides (idle timeout,
// memory pressure, etc.) and restart fresh on the next incoming message.
// Without persistence, a mid-game restart loses all captured event data.
//
// We persist currentSession to chrome.storage.local on a debounced write so
// that on restart it can be restored and event accumulation continues.

const SESSION_STORE_KEY = "kt_current_session";
const GUARD_STORE_KEY = "kt_post_game_guard";

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (currentSession) {
      chrome.storage.local.set({ [SESSION_STORE_KEY]: currentSession });
    } else {
      chrome.storage.local.remove(SESSION_STORE_KEY);
    }
  }, 3000); // batch writes — flush 3 seconds after last change
}

function clearPersistedSession(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  chrome.storage.local.remove(SESSION_STORE_KEY);
}

// Restore session and guard state on service worker startup.
chrome.storage.local
  .get([SESSION_STORE_KEY, GUARD_STORE_KEY])
  .then((result) => {
    const saved = result[SESSION_STORE_KEY] as GameSession | undefined;
    if (saved?.sessionId) {
      currentSession = saved;
      setBadge("●", "#1565c0");
    }
    const guard = result[GUARD_STORE_KEY] as
      | { players: string[]; expiry: number }
      | undefined;
    if (guard && guard.expiry > Date.now()) {
      postGamePlayerSet = new Set(guard.players);
      postGameGuardExpiry = guard.expiry;
    } else if (guard) {
      chrome.storage.local.remove(GUARD_STORE_KEY);
    }
  });

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
  if (guardActive()) {
    // Empty player list (players={}) is always a post-game or lobby artifact —
    // never a real new game starting. Block it while the guard is active.
    if (!playerNames || playerNames.length === 0) return null;
    // Block only if EVERY player was in the previous game — handles partial
    // post-game gamestates (subset of players) while allowing new opponents
    // immediately (they introduce a player not in the post-game set).
    const isRematchOrPostGame = playerNames.every((n) => postGamePlayerSet!.has(n));
    if (isRematchOrPostGame) return null; // still in post-game / rematch context
    // At least one new player → new opponent, clear immediately
    clearPostGameGuard();
  }
  if (!currentSession) {
    // Never start a new session from a gamestate without both players present.
    // Delta gamestates, spectator broadcasts, and post-game lobby artifacts all
    // arrive with players={} — requiring 2 known players prevents phantom sessions
    // from other games that the lobby socket broadcasts to all connected clients.
    if (!playerNames || playerNames.length < 2) return null;
    currentSession = makeSession();
    setBadge("●", "#1565c0"); // blue: in progress
    schedulePersist();
  }
  return currentSession;
}

function clearPostGameGuard(): void {
  postGamePlayerSet = null;
  postGameGuardExpiry = null;
  chrome.storage.local.remove(GUARD_STORE_KEY);
}

// ─── Log Builder ─────────────────────────────────────────────────────────────
//
// The tracker's log_to_game() parser requires these lines to be present:
//   "{player} brings {deck} to The Crucible" × 2    (PLAYER_DECK_MATCHER)
//   "{player} won the flip"                          (FIRST_PLAYER_MATCHER)
//   "{winner} has won the game"                      (WIN_MATCHER)
//
// It also extracts (when present):
//   "{player} chooses {house} as their active house this turn" (HOUSE_CHOICE_MATCHER)
//   "{player} forges the {color} key, paying {N} Æmber"       (FORGE_MATCHER)
//
// We reconstruct the full log from captured gamestates so these richer fields
// are populated. The "brings" / "won the flip" lines live in early pre-game
// gamestates we may not have captured, so we inject them from session metadata.

// Socket.IO parts can be strings, numbers, or objects with a `name` field.
function partText(p: unknown): string {
  if (typeof p === "string") return p;
  if (typeof p === "number") return String(p);
  if (typeof p === "object" && p !== null) {
    return String((p as Record<string, unknown>).name ?? "");
  }
  return "";
}

// Crucible uses internal key identifiers that differ from the backend's expected format.
// FORGE_MATCHER expects: "forges the Red key, paying 6 Æmber"
// Socket sends:          "forges the forgedkeyred, paying 6 amber"
const FORGE_KEY_MAP: Record<string, string> = {
  forgedkeyred: "Red key",
  forgedkeyyellow: "Yellow key",
  forgedkeyblue: "Blue key",
};

function transformLogLine(line: string): string {
  return line.replace(
    /forges the (forgedkey\w+), paying (\d+) amber/,
    (_m, keyId: string, cost: string) =>
      `forges the ${FORGE_KEY_MAP[keyId] ?? keyId}, paying ${cost} Æmber`
  );
}

// Reconstruct the full game log from captured gamestate snapshots.
// Each snapshot may have:
//   messages: [{id, message:[parts]}]       — pre-game list format
//   messages: {"5": [{message:[parts]}], …} — in-game delta dict format
function buildFullLog(session: GameSession): string {
  const p1 = session.player1 ?? "Player1";
  const p2 = session.player2 ?? "Player2";
  const d1 = session.player1DeckName ?? "UNSET";
  const d2 = session.player2DeckName ?? "UNSET";
  const rawWinner = session.winner ?? "";
  const winner = rawWinner && rawWinner !== "unknown" ? rawWinner : p1;

  // Inject header lines — these live in early pre-game gamestates that may
  // not have been captured (before both players were present).
  const header = [
    `${p1} brings ${d1} to The Crucible`,
    `${p2} brings ${d2} to The Crucible`,
    `${p1} won the flip`,
  ];

  const seenKeys = new Set<string>();
  const bodyLines: string[] = [];

  for (const snapshot of session.gamestateSnapshots) {
    const gs = snapshot as Record<string, unknown>;
    const messages = gs?.messages;

    if (Array.isArray(messages)) {
      // Pre-game list format
      for (const item of messages) {
        if (typeof item !== "object" || item === null) continue;
        const m = item as Record<string, unknown>;
        const msgId = String(m.id ?? "");
        if (msgId && seenKeys.has(msgId)) continue;
        if (msgId) seenKeys.add(msgId);
        const parts = m.message;
        if (!Array.isArray(parts)) continue;
        const text = transformLogLine(parts.map(partText).join("").trim());
        if (text) bodyLines.push(text);
      }
    } else if (typeof messages === "object" && messages !== null) {
      // In-game delta dict format — sort keys numerically, deduplicate
      const dict = messages as Record<string, unknown>;
      const numKeys = Object.keys(dict)
        .filter((k) => k !== "_t")
        .sort((a, b) => Number(a) - Number(b));

      for (const k of numKeys) {
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        const raw = dict[k];
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
          if (typeof item !== "object" || item === null) continue;
          const parts = (item as Record<string, unknown>).message;
          if (!Array.isArray(parts)) continue;
          const text = transformLogLine(parts.map(partText).join("").trim());
          if (text) bodyLines.push(text);
        }
      }
    }
  }

  // Ensure the win line is present — may be absent for concede/leave games
  // where we detect the winner via inference rather than a direct log message.
  const hasWinLine = bodyLines.some(
    (l) => l.includes("has won the game") || l.includes("concedes") || l.includes("has conceded")
  );
  if (!hasWinLine) {
    bodyLines.push(`${winner} has won the game`);
  }

  return [...header, ...bodyLines].join("\n");
}

function buildLog(session: GameSession): string {
  if (session.gamestateSnapshots.length > 0) {
    return buildFullLog(session);
  }
  // Fallback: minimal 4-line synthetic log when no gamestates were captured
  const p1 = session.player1 ?? "Player1";
  const p2 = session.player2 ?? "Player2";
  const rawWinner = session.winner ?? "";
  const winner = rawWinner && rawWinner !== "unknown" ? rawWinner : p1;
  const d1 = session.player1DeckName ?? "UNSET";
  const d2 = session.player2DeckName ?? "UNSET";
  return [
    `${p1} brings ${d1} to The Crucible`,
    `${p2} brings ${d2} to The Crucible`,
    `${p1} won the flip`,
    `${winner} has won the game`,
  ].join("\n");
}

// ─── Turn Timing ─────────────────────────────────────────────────────────────
//
// Walk gamestateSnapshots exactly like buildFullLog(), but only process in-game
// dict-format messages (house choices only happen in-game). For each message that
// matches "X chooses Y as their active house this turn", record a TurnTimingEntry
// using the snapshot's `date` field as the timestamp.

const HOUSE_CHOICE_RE = /^(\S+) chooses (\S+) as their active house this turn/;

function buildTurnTiming(session: GameSession): TurnTimingEntry[] {
  const seenKeys = new Set<string>();
  const entries: TurnTimingEntry[] = [];
  let turnNumber = 0;

  for (const snapshot of session.gamestateSnapshots) {
    const gs = snapshot as Record<string, unknown>;
    const messages = gs?.messages;
    if (typeof messages !== "object" || messages === null || Array.isArray(messages)) {
      continue; // skip pre-game list format
    }

    // In-game delta dict format — sort keys numerically
    const dict = messages as Record<string, unknown>;
    const numKeys = Object.keys(dict)
      .filter((k) => k !== "_t")
      .sort((a, b) => Number(a) - Number(b));

    for (const k of numKeys) {
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      const raw = dict[k];
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const m = item as Record<string, unknown>;
        const parts = m.message;
        if (!Array.isArray(parts)) continue;
        const text = parts.map(partText).join("").trim();
        const match = HOUSE_CHOICE_RE.exec(text);
        if (match) {
          turnNumber++;
          const dateStr = typeof m.date === "string" ? m.date : null;
          const timestamp_ms = dateStr ? new Date(dateStr).getTime() : Date.now();
          entries.push({
            turn: turnNumber,
            player: match[1],
            house: match[2],
            timestamp_ms,
          });
        }
      }
    }
  }

  return entries;
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

  // Submit extended data (turn timing) — non-fatal if it fails
  if (session.crucibleGameId) {
    const timing = buildTurnTiming(session);
    if (timing.length > 0) {
      session.turnTiming = timing;
      const submitter =
        settings.tcoUsername ||
        session.winner ||
        session.player1 ||
        session.player2 ||
        "";
      const extUrl = `${settings.trackerUrl}/api/v2/upload/extended`;
      const manifest = chrome.runtime.getManifest();
      fetch(extUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crucible_game_id: session.crucibleGameId,
          submitter_username: submitter,
          extension_version: manifest.version,
          turn_timing: timing,
        }),
      }).catch((err: Error) => {
        console.warn("[KT] Extended data upload failed:", err.message);
      });
    }
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

  // Persist guard state so a service worker restart within the post-game
  // window still blocks spurious re-sessions for the same players.
  if (postGamePlayerSet !== null && postGameGuardExpiry !== null) {
    chrome.storage.local.set({
      [GUARD_STORE_KEY]: {
        players: [...postGamePlayerSet],
        expiry: postGameGuardExpiry,
      },
    });
  }

  currentSession.endTime = Date.now();
  currentSession.gameEndReason = reason;
  currentSession.finalLog = buildLog(currentSession);
  completedSessions.push(currentSession);
  currentSession = null;
  clearPersistedSession(); // game ended — no need to keep session in storage
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
      }
      if (!session.player2 && playerNames[1]) {
        session.player2 = playerNames[1];
      }
      // Fill in missing deck names whenever a gamestate has player data.
      // We check on every gamestate (not just first) because the deck entry
      // may not be populated yet in the very first two-player gamestate.
      for (const [pname, slot] of [
        [session.player1, "player1DeckName"],
        [session.player2, "player2DeckName"],
      ] as [string | undefined, keyof GameSession][]) {
        if (pname && !session[slot] && pd[pname]) {
          const deck = pd[pname]?.deck as Record<string, unknown> | undefined;
          const dname = deck?.name;
          if (typeof dname === "string") (session[slot] as string) = dname;
        }
      }
      schedulePersist();
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
      // Deck UUID and name extracted from DOM "brings [deck] to The Crucible" anchor tag.
      // The anchor's textContent is the deck name — use it to fill missing deck names
      // (the "brings" messages live in pre-game gamestates we may not have captured).
      // Associate with whichever player matches, in either active or the most
      // recent completed session (link may fire slightly after game end event).
      const link = data as Record<string, unknown>;
      const deckId = typeof link?.deckId === "string" ? link.deckId : null;
      const deckName = typeof link?.deckName === "string" ? link.deckName : null;
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
            if (deckName && !target.player1DeckName) target.player1DeckName = deckName;
            if (currentSession) currentSession.events.push(event);
          } else if (playerName && playerName === target.player2 && !target.player2DeckId) {
            target.player2DeckId = deckId;
            if (deckName && !target.player2DeckName) target.player2DeckName = deckName;
            if (currentSession) currentSession.events.push(event);
          } else if (!playerName) {
            // No player context — fill in whichever slot is empty
            if (!target.player1DeckId) {
              target.player1DeckId = deckId;
              if (deckName && !target.player1DeckName) target.player1DeckName = deckName;
            } else if (!target.player2DeckId) {
              target.player2DeckId = deckId;
              if (deckName && !target.player2DeckName) target.player2DeckName = deckName;
            }
            if (currentSession) currentSession.events.push(event);
          }
        }
      }
      schedulePersist();
      break;
    }

    case "KT_STORE_FOUND":
    case "KT_GAME_CHAT":
    case "KT_WS_CLOSE":
      if (currentSession) {
        currentSession.events.push(event);
        schedulePersist();
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
      clearPersistedSession();
      setBadge("", "#666666");
      sendResponse({ ok: true });
      return false;
    }

    return false;
  }
);

// ─── Init ─────────────────────────────────────────────────────────────────────

setBadge("", "#666666"); // grey: idle

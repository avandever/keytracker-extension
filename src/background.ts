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
  KeyForgeEvent,
  HandCardSnapshot,
  BoardCardSnapshot,
  TurnSnapshot,
} from "./types";

// ─── Settings ────────────────────────────────────────────────────────────────

const TRACKER_URL = "https://tracker.ancientbearrepublic.com";

const DEFAULT_SETTINGS: Settings = {
  autoSubmit: true,
  debugMode: false,
  autoSaveDebugLog: false,
};

// Local player username detected from the page (DOM / Redux auth state)
let localPlayer = "";

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
  if (!settings.debugMode && !settings.autoSaveDebugLog) return;
  debugLog.push({ ts: Date.now(), type, detail, guardBlocked });
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
}

function autoSaveDebugLogToDownloads(session: GameSession): void {
  if (!settings.autoSaveDebugLog) return;
  const label = session.crucibleGameId
    ? session.crucibleGameId.slice(0, 8)
    : session.sessionId.slice(3, 11);
  const date = new Date(session.endTime ?? Date.now()).toISOString().slice(0, 10);
  const filename = `kt_debug/kt_debug_${label}_${date}.json`;
  const payload = {
    session: {
      sessionId: session.sessionId,
      crucibleGameId: session.crucibleGameId,
      player1: session.player1,
      player2: session.player2,
      winner: session.winner,
      player1DeckName: session.player1DeckName,
      player2DeckName: session.player2DeckName,
      player1DeckId: session.player1DeckId,
      player2DeckId: session.player2DeckId,
      gameEndReason: session.gameEndReason,
      snapshotCount: session.gamestateSnapshots.length,
    },
    debugLog,
  };
  const dataUrl =
    "data:application/json;base64," +
    btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))));
  chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

// ─── State ──────────────────────────────────────────────────────────────────

let currentSession: GameSession | null = null;
const completedSessions: GameSession[] = [];

// ─── Storage Restore Guard ───────────────────────────────────────────────────
//
// MV3 service workers restart with no state. chrome.storage.local.get() is
// async — events arriving before it resolves see guardActive()=false and can
// create phantom sessions from post-game gamestates. We buffer all incoming
// events until the Promise resolves, then drain them in order.

let storageRestored = false;
const pendingEvents: Array<{
  type: InjectEventType;
  timestamp: number;
  data: unknown;
}> = [];

function drainPendingEvents(): void {
  const toProcess = pendingEvents.splice(0);
  for (const e of toProcess) {
    handleInjectEvent(e.type, e.timestamp, e.data);
  }
}

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
      | { players: string[]; expiry: number; crucibleId?: string }
      | undefined;
    if (guard && guard.expiry > Date.now()) {
      postGamePlayerSet = new Set(guard.players);
      postGameGuardExpiry = guard.expiry;
      postGameCrucibleId = guard.crucibleId ?? null;
    } else if (guard) {
      chrome.storage.local.remove(GUARD_STORE_KEY);
    }
    storageRestored = true;
    drainPendingEvents();
  });

// ─── Session Management ──────────────────────────────────────────────────────

// After a game ends, block new sessions with the same player set for a
// grace period (POST_GAME_GUARD_MS). For a different opponent the guard clears
// immediately (different player set = new opponent, no risk of double-session).
// For rematches (same players, new game), we use the game UUID to distinguish:
// gamestates carrying the previous game's UUID are post-game artifacts; a
// different UUID means the new game has genuinely started.
const POST_GAME_GUARD_MS = 90_000; // 90 seconds — post-game gamestates last ~55s
const PRE_GAME_TIMEOUT_MS = 5 * 60_000; // 5 minutes — discard lobby sessions that never launched

let postGamePlayerSet: Set<string> | null = null;
let postGameGuardExpiry: number | null = null;
let postGameCrucibleId: string | null = null; // UUID of the completed game

function guardActive(): boolean {
  if (postGamePlayerSet === null) return false;
  if (postGameGuardExpiry !== null && Date.now() > postGameGuardExpiry) {
    clearPostGameGuard();
    return false;
  }
  return true;
}

function ensureSession(playerNames?: string[], incomingGameId?: string): GameSession | null {
  if (guardActive()) {
    // Empty player list (players={}) is always a post-game or lobby artifact —
    // never a real new game starting. Block it while the guard is active.
    if (!playerNames || playerNames.length === 0) return null;
    // Block only if EVERY player was in the previous game — handles partial
    // post-game gamestates (subset of players) while allowing new opponents
    // immediately (they introduce a player not in the post-game set).
    const isRematchOrPostGame = playerNames.every((n) => postGamePlayerSet!.has(n));
    if (isRematchOrPostGame) {
      // Rematches: allow through if the gamestate carries a DIFFERENT game UUID —
      // that's proof the new game has started, not a post-game broadcast.
      if (incomingGameId && postGameCrucibleId && incomingGameId !== postGameCrucibleId) {
        console.log(`[KT] Guard cleared — new game UUID detected (${incomingGameId.slice(0, 8)})`);
        clearPostGameGuard();
      } else {
        const expiresIn = postGameGuardExpiry ? Math.round((postGameGuardExpiry - Date.now()) / 1000) : 0;
        console.log(`[KT] Guard blocked session for players=[${playerNames.join(",")}] — same game UUID or unknown, expires in ${expiresIn}s`);
        return null; // still in post-game / rematch context
      }
    } else {
      // At least one new player → new opponent, clear immediately
      console.log(`[KT] Guard cleared — new opponent detected players=[${playerNames.join(",")}]`);
      clearPostGameGuard();
    }
  }
  // Discard a pre-game session that sat in the lobby too long without launching.
  // Checked on every gamestate so cleanup is prompt once activity resumes.
  if (currentSession && !currentSession.gameStarted) {
    const age = Date.now() - currentSession.startTime;
    if (age > PRE_GAME_TIMEOUT_MS) {
      console.log(`[KT] Pre-game session timed out after ${Math.round(age / 1000)}s, discarding ${currentSession.sessionId}`);
      dlog("DISCARD", `session ${currentSession.sessionId} discarded — pre-game timeout (${Math.round(age / 1000)}s)`, false);
      currentSession = null;
      clearPersistedSession();
      setBadge("", "#666666");
    }
  }

  if (!currentSession) {
    // Never start a new session from a gamestate without both players present.
    // Delta gamestates, spectator broadcasts, and post-game lobby artifacts all
    // arrive with players={} — requiring 2 known players prevents phantom sessions
    // from other games that the lobby socket broadcasts to all connected clients.
    if (!playerNames || playerNames.length < 2) return null;
    currentSession = makeSession();
    console.log(`[KT] Session started: ${currentSession.sessionId} players=[${playerNames.join(",")}]`);
    setBadge("●", "#1565c0"); // blue: in progress
    schedulePersist();
  }
  return currentSession;
}

function clearPostGameGuard(): void {
  postGamePlayerSet = null;
  postGameGuardExpiry = null;
  postGameCrucibleId = null;
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
  const rawLoser = session.loser ?? "";
  const winner =
    rawWinner && rawWinner !== "unknown"
      ? rawWinner
      : rawLoser && rawLoser !== "unknown"
        ? rawLoser === p1 ? p2 : p1  // winner is the one who didn't leave
        : p1;                          // last resort — can't determine

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
  const rawLoser = session.loser ?? "";
  const winner =
    rawWinner && rawWinner !== "unknown"
      ? rawWinner
      : rawLoser && rawLoser !== "unknown"
        ? rawLoser === p1 ? p2 : p1
        : p1;
  const d1 = session.player1DeckName ?? "UNSET";
  const d2 = session.player2DeckName ?? "UNSET";
  return [
    `${p1} brings ${d1} to The Crucible`,
    `${p2} brings ${d2} to The Crucible`,
    `${p1} won the flip`,
    `${winner} has won the game`,
  ].join("\n");
}

// ─── Turn Snapshot Helpers ───────────────────────────────────────────────────

// Parse a Crucible sparse-array object (dict with numeric keys + optional "_t")
// into a flat array. Mirrors the in-game message dict parsing in buildFullLog.
function parseSparseArray(obj: unknown): unknown[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const dict = obj as Record<string, unknown>;
  return Object.keys(dict)
    .filter((k) => !k.startsWith("_"))   // drop _t, _0, _4, etc. (delta markers)
    .sort((a, b) => Number(a) - Number(b))
    .flatMap((k) => {
      const v = dict[k];
      return Array.isArray(v) ? v : [v];
    })
    .filter(Boolean);
}



// Card location tracker types — accumulated across all gamestates in buildGameEvents.
type CardPileMap = Map<string, string>;           // cardId → pileName
type CardDataMap = Map<string, Record<string, unknown>>; // cardId → merged card fields

// Extract a turn snapshot using accumulated card tracking maps rather than raw
// delta snapshots. Crucible sends jsondiffpatch deltas, so a single snapshot
// only has cards that *changed* — not all cards currently in hand/play. By
// accumulating card locations across all snapshots we get accurate counts.
function extractTurnSnapshot(
  housePicker: string,
  house: string,
  turnNumber: number,
  timestamp_ms: number,
  effectiveLocalPlayer: string,
  playerCardPile: Map<string, CardPileMap>,
  playerCardData: Map<string, CardDataMap>,
  playerAmber: Map<string, number>,
  playerDeckSize: Map<string, number>
): TurnSnapshot {
  const amber: Record<string, number> = {};
  const deck_size: Record<string, number> = {};
  const discard_size: Record<string, number> = {};
  const archive_size: Record<string, number> = {};
  const boards: Record<string, BoardCardSnapshot[]> = {};
  let local_hand: HandCardSnapshot[] = [];

  for (const [pname, cardPileMap] of playerCardPile.entries()) {
    const cardDataMap = playerCardData.get(pname)!;
    amber[pname] = playerAmber.get(pname) ?? 0;
    deck_size[pname] = playerDeckSize.get(pname) ?? 0;
    let discardCount = 0;
    let archiveCount = 0;
    const boardCards: BoardCardSnapshot[] = [];
    const handCards: HandCardSnapshot[] = [];

    for (const [cardId, pile] of cardPileMap.entries()) {
      const card = cardDataMap.get(cardId) ?? {};
      if (pile === "discard") {
        discardCount++;
      } else if (pile === "archives") {
        archiveCount++;
      } else if (pile === "cardsInPlay") {
        const boardCard: BoardCardSnapshot = {
          id: cardId,
          name: String(card.name ?? ""),
          type: String(card.type ?? ""),
          house: String(card.printedHouse ?? ""),
          power: Number(card.modifiedPower ?? 0),
          amber: Number(card.cardPrintedAmber ?? 0),
          exhausted: Boolean(card.exhausted),
          stunned: Boolean(card.stunned),
          taunt: Boolean(card.taunt),
        };
        const enh = card.enhancements;
        if (Array.isArray(enh) && enh.length > 0) boardCard.enhancements = enh as string[];
        boardCards.push(boardCard);
      } else if (pile === "hand" && pname === effectiveLocalPlayer) {
        if (card.facedown === false) {
          const handCard: HandCardSnapshot = {
            id: cardId,
            name: String(card.name ?? ""),
            type: String(card.type ?? ""),
            house: String(card.printedHouse ?? ""),
            amber: Number(card.cardPrintedAmber ?? 0),
            can_play: Boolean(card.canPlay ?? true),
          };
          const enh = card.enhancements;
          if (Array.isArray(enh) && enh.length > 0) handCard.enhancements = enh as string[];
          handCards.push(handCard);
        }
      }
    }

    discard_size[pname] = discardCount;
    archive_size[pname] = archiveCount;
    boards[pname] = boardCards;
    if (pname === effectiveLocalPlayer) local_hand = handCards;
  }

  return {
    turn: turnNumber,
    player: housePicker,
    house,
    timestamp_ms,
    local_hand,
    boards,
    amber,
    deck_size,
    discard_size,
    archive_size,
  };
}

// ─── Game Events (Turn Timing + Key Forge) ───────────────────────────────────
//
// Single-pass walk over gamestateSnapshots (in-game dict-format only).
// Avoids turn-counter drift between timing and forge extraction.

const HOUSE_CHOICE_RE = /^(\S+) chooses (\S+) as their active house this turn/;
const FORGE_EVENT_RE = /^(\S+) forges the (forgedkey\w+), paying (\d+) amber/;
const FORGE_COLOR_MAP: Record<string, string> = {
  forgedkeyred: "Red",
  forgedkeyyellow: "Yellow",
  forgedkeyblue: "Blue",
};

// The pile names we track card movements through.
const TRACKED_PILES = [
  "hand",
  "cardsInPlay",
  "discard",
  "archives",
  "purged",
] as const;

function buildGameEvents(session: GameSession): {
  turnTiming: TurnTimingEntry[];
  keyEvents: KeyForgeEvent[];
  turnSnapshots: TurnSnapshot[];
  localPlayer: string;
} {
  const snaps = session.gamestateSnapshots;
  const seenKeys = new Set<string>();
  const turnTiming: TurnTimingEntry[] = [];
  const keyEvents: KeyForgeEvent[] = [];
  const turnSnapshots: TurnSnapshot[] = [];
  let turnNumber = 0;

  // Accumulated card-location state: updated on every gamestate (delta or full).
  // Crucible uses jsondiffpatch format: card added to a pile → value is [card_obj].
  // We record the most-recent pile each card was seen entering, and merge card
  // fields so we always have up-to-date data when we need a turn snapshot.
  const playerCardPile = new Map<string, CardPileMap>();
  const playerCardData = new Map<string, CardDataMap>();
  const playerAmber = new Map<string, number>();
  const playerDeckSize = new Map<string, number>();

  function updateTracking(gs: Record<string, unknown>): void {
    const players = gs?.players as Record<string, unknown> | undefined;
    if (!players) return;
    for (const [pname, pdata] of Object.entries(players)) {
      const p = pdata as Record<string, unknown>;
      // Accumulate amber from stats (delta format: [old, new])
      const amberArr = (p?.stats as Record<string, unknown> | undefined)?.amber;
      if (Array.isArray(amberArr) && typeof amberArr[1] === "number") {
        playerAmber.set(pname, amberArr[1]);
      }
      // Accumulate deck size from numDeckCards (present on some snapshots)
      if (typeof p?.numDeckCards === "number") {
        playerDeckSize.set(pname, p.numDeckCards as number);
      }
      const cardPiles = p?.cardPiles as Record<string, unknown> | undefined;
      if (!cardPiles) continue;
      if (!playerCardPile.has(pname)) {
        playerCardPile.set(pname, new Map());
        playerCardData.set(pname, new Map());
      }
      const cardPileMap = playerCardPile.get(pname)!;
      const cardDataMap = playerCardData.get(pname)!;
      for (const pileName of TRACKED_PILES) {
        const pile = cardPiles[pileName];
        if (!pile || typeof pile !== "object" || Array.isArray(pile)) continue;
        for (const [k, v] of Object.entries(pile as Record<string, unknown>)) {
          if (k.startsWith("_")) continue;
          // jsondiffpatch "added" format: [card_obj] (single-element array with full data)
          if (!Array.isArray(v) || v.length !== 1) continue;
          const card = v[0] as Record<string, unknown>;
          if (typeof card !== "object" || card === null) continue;
          const cardId = card.id;
          if (typeof cardId !== "string" || !cardId) continue;
          // Record where this card is now (overwrites prior pile)
          cardPileMap.set(cardId, pileName);
          // Merge card fields (newer fields win; preserves data from initial full state)
          cardDataMap.set(cardId, { ...(cardDataMap.get(cardId) ?? {}), ...card });
        }
      }
    }
  }

  for (let snapIdx = 0; snapIdx < snaps.length; snapIdx++) {
    const snapshot = snaps[snapIdx];
    const gs = snapshot as Record<string, unknown>;

    // Update card-location tracking on every snapshot (deltas are cumulative)
    updateTracking(gs);

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
        const dateStr = typeof m.date === "string" ? m.date : null;
        const timestamp_ms = dateStr ? new Date(dateStr).getTime() : Date.now();

        const houseMatch = HOUSE_CHOICE_RE.exec(text);
        if (houseMatch) {
          turnNumber++;
          // Detect local player from accumulated card data: the player whose hand
          // has cards with facedown:false (opponent's hand cards are always facedown).
          let effectiveLocalPlayer = localPlayer;
          if (!effectiveLocalPlayer) {
            for (const [pname, cpMap] of playerCardPile.entries()) {
              const cdMap = playerCardData.get(pname)!;
              if (
                [...cpMap.entries()].some(
                  ([id, pile]) => pile === "hand" && cdMap.get(id)?.facedown === false
                )
              ) {
                effectiveLocalPlayer = pname;
                break;
              }
            }
          }
          turnTiming.push({
            turn: turnNumber,
            player: houseMatch[1],
            house: houseMatch[2],
            timestamp_ms,
          });
          turnSnapshots.push(
            extractTurnSnapshot(
              houseMatch[1],
              houseMatch[2],
              turnNumber,
              timestamp_ms,
              effectiveLocalPlayer,
              playerCardPile,
              playerCardData,
              playerAmber,
              playerDeckSize
            )
          );
          continue;
        }

        const forgeMatch = FORGE_EVENT_RE.exec(text);
        if (forgeMatch) {
          keyEvents.push({
            turn: turnNumber,
            player: forgeMatch[1],
            key_color: FORGE_COLOR_MAP[forgeMatch[2]] ?? forgeMatch[2],
            amber_paid: Number(forgeMatch[3]),
            timestamp_ms,
          });
        }
      }
    }
  }

  // Determine effective local player: the player with facedown:false hand cards.
  // Computed here so doSubmit can use the same value for submitter_username.
  let detectedLocalPlayer = localPlayer;
  if (!detectedLocalPlayer) {
    for (const [pname, cpMap] of playerCardPile.entries()) {
      const cdMap = playerCardData.get(pname)!;
      if (
        [...cpMap.entries()].some(
          ([id, pile]) => pile === "hand" && cdMap.get(id)?.facedown === false
        )
      ) {
        detectedLocalPlayer = pname;
        break;
      }
    }
  }

  return { turnTiming, keyEvents, turnSnapshots, localPlayer: detectedLocalPlayer };
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

  console.log(
    `[KT] Submitting session ${session.sessionId}:` +
    ` crucibleGameId=${session.crucibleGameId ?? "none"}` +
    ` players=[${session.player1 ?? "?"},${session.player2 ?? "?"}]` +
    ` winner=${session.winner ?? "?"}` +
    ` decks=[${session.player1DeckName ?? "UNSET"},${session.player2DeckName ?? "UNSET"}]` +
    ` deckIds=[${session.player1DeckId ?? "none"},${session.player2DeckId ?? "none"}]` +
    ` logLines=${log.split("\n").length}`
  );

  const url = `${TRACKER_URL}/api/upload_log/v1`;
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
  console.log(`[KT] Submission succeeded: game_id=${session.submittedGameId ?? "?"} session=${session.sessionId}`);

  // Submit extended data (turn timing + key forge events + snapshots) — non-fatal if it fails
  if (session.crucibleGameId) {
    let turnTiming: ReturnType<typeof buildGameEvents>["turnTiming"] = [];
    let keyEvents: ReturnType<typeof buildGameEvents>["keyEvents"] = [];
    let turnSnapshots: ReturnType<typeof buildGameEvents>["turnSnapshots"] = [];
    let detectedLocal = "";
    try {
      const result = buildGameEvents(session);
      turnTiming = result.turnTiming;
      keyEvents = result.keyEvents;
      turnSnapshots = result.turnSnapshots;
      detectedLocal = result.localPlayer;
    } catch (err) {
      console.error("[KT] buildGameEvents failed:", err);
    }
    console.log(
      `[KT] Extended data: turns=${turnTiming.length} keyEvents=${keyEvents.length}` +
      ` snapshots=${turnSnapshots.length} session=${session.sessionId}`
    );
    if (turnTiming.length > 0 || keyEvents.length > 0 || turnSnapshots.length > 0) {
      session.turnTiming = turnTiming;
      session.keyEvents = keyEvents;
      session.turnSnapshots = turnSnapshots;
      // Use the player detected from card tracking (facedown:false hand cards),
      // which is more reliable than the global localPlayer or session.winner fallback.
      const submitter =
        detectedLocal ||
        session.player1 ||
        session.player2 ||
        "";
      const extUrl = `${TRACKER_URL}/api/v2/upload/extended`;
      const manifest = chrome.runtime.getManifest();
      fetch(extUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crucible_game_id: session.crucibleGameId,
          submitter_username: submitter,
          extension_version: manifest.version,
          turn_timing: turnTiming,
          key_events: keyEvents,
          turn_snapshots: turnSnapshots,
        }),
      }).catch((err: Error) => {
        console.warn("[KT] Extended data upload failed:", err.message);
      });
    } else {
      console.warn(`[KT] No extended data to upload for session ${session.sessionId}`);
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
  postGameCrucibleId = currentSession.crucibleGameId ?? null;

  // Persist guard state so a service worker restart within the post-game
  // window still blocks spurious re-sessions for the same players.
  if (postGamePlayerSet !== null && postGameGuardExpiry !== null) {
    chrome.storage.local.set({
      [GUARD_STORE_KEY]: {
        players: [...postGamePlayerSet],
        expiry: postGameGuardExpiry,
        crucibleId: postGameCrucibleId,
      },
    });
  }

  currentSession.endTime = Date.now();
  currentSession.gameEndReason = reason;
  currentSession.finalLog = buildLog(currentSession);
  const _fs = currentSession;
  console.log(
    `[KT] Session finalized: ${_fs.sessionId} reason=${reason}` +
    ` winner=${_fs.winner ?? "?"} players=[${_fs.player1 ?? "?"},${_fs.player2 ?? "?"}]` +
    ` decks=[${_fs.player1DeckName ?? "UNSET"},${_fs.player2DeckName ?? "UNSET"}]` +
    ` deckIds=[${_fs.player1DeckId ?? "none"},${_fs.player2DeckId ?? "none"}]` +
    ` snapshots=${_fs.gamestateSnapshots.length} logLines=${_fs.finalLog.split("\n").length}`
  );
  completedSessions.push(currentSession);
  const justFinalized = completedSessions[completedSessions.length - 1];
  currentSession = null;
  clearPersistedSession(); // game ended — no need to keep session in storage
  setBadge(`${completedSessions.length}`, "#2e7d32"); // green: completed

  autoSaveDebugLogToDownloads(justFinalized);

  if (settings.autoSubmit) {
    const justFinished = completedSessions[completedSessions.length - 1];
    const canDetermineWinner =
      (justFinished.winner && justFinished.winner !== "unknown") ||
      (justFinished.loser && justFinished.loser !== "unknown");
    if (!canDetermineWinner) {
      dlog(
        "SKIP_SUBMIT",
        `session ${justFinished.sessionId} — winner and loser both unknown, not auto-submitting`,
        false
      );
    } else {
      doSubmit(justFinished).catch((err: Error) => {
        justFinished.submitError = err.message;
      });
    }
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
  // Buffer events until storage restore completes so guardActive() reflects
  // the correct post-game state and doesn't create phantom sessions.
  if (!storageRestored) {
    pendingEvents.push({ type, timestamp, data });
    return;
  }

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
      const gsGameId = typeof gs?.id === "string" ? gs.id : undefined;
      const session = ensureSession(playerNames, gsGameId);
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

      // Detect game start from house-choice messages in in-game dict-format messages.
      // Any "X chooses Y as their active house" line confirms the game is underway.
      if (!session.gameStarted) {
        const msgs = gs?.messages;
        if (typeof msgs === "object" && msgs !== null && !Array.isArray(msgs)) {
          const dict = msgs as Record<string, unknown>;
          outer: for (const [k, raw] of Object.entries(dict)) {
            if (k === "_t") continue;
            const items = Array.isArray(raw) ? raw : [raw];
            for (const item of items) {
              if (typeof item !== "object" || item === null) continue;
              const parts = (item as Record<string, unknown>).message;
              if (!Array.isArray(parts)) continue;
              const text = parts.map(partText).join("").trim();
              if (/chooses .+ as their active house/.test(text)) {
                session.gameStarted = true;
                break outer;
              }
            }
          }
        }
      }

      // Extract the crucible game ID from lobby-phase gamestates (before handoff).
      // The pre-game gamestate has a top-level `id` field that IS the game UUID.
      // We prefer this over the lobby socket `updategame` events, which broadcast
      // ALL active games and can accidentally pick up a different game's UUID.
      if (gsGameId && !session.crucibleGameId) {
        session.crucibleGameId = gsGameId;
      }

      const pd = playersDict as Record<string, Record<string, unknown>>;
      // Before the game starts, the lobby can change as players join/leave.
      // Keep player names in sync with the current gamestate so we capture the
      // actual players, not whoever happened to be in the lobby first.
      // Once the game starts (first house-choice seen), lock player names in place.
      if (!session.gameStarted && playerNames.length >= 2) {
        if (playerNames[0] !== session.player1) {
          session.player1 = playerNames[0];
          session.player1DeckId = undefined;
          session.player1DeckName = undefined;
        }
        if (playerNames[1] !== session.player2) {
          session.player2 = playerNames[1];
          session.player2DeckId = undefined;
          session.player2DeckName = undefined;
        }
      } else {
        if (!session.player1 && playerNames[0]) session.player1 = playerNames[0];
        if (!session.player2 && playerNames[1]) session.player2 = playerNames[1];
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
          if (typeof dname === "string") {
            (session[slot] as string) = dname;
            console.log(`[KT] Deck name from gamestate: player=${pname} slot=${String(slot)} name=${dname}`);
          }
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
      currentSession.loser = String(end?.loser ?? "");
      finalizeSession("win_detected");
      break;
    }

    case "KT_SOCKET_EVENT": {
      const ev = data as Record<string, unknown>;

      // handoff fires exactly once per game when the client's socket is handed
      // off from lobby server to game server. It's the definitive signal that
      // a NEW game has started — safe to clear the post-game guard here.
      if (ev?.eventName === "handoff") {
        // handoff = socket handed off from lobby to game server.
        // We no longer use this to clear the post-game guard (that caused
        // phantom sessions for rematches). Game UUID comparison in ensureSession
        // is now the authoritative way to allow same-player rematches.
        dlog("KT_SOCKET_EVENT", "handoff received", false);
        if (currentSession) currentSession.gameStarted = true;
      } else if (ev?.eventName === "removegame" && currentSession && !currentSession.gameStarted) {
        // The lobby was disbanded before the game started — discard the session.
        console.log(`[KT] removegame: discarding pre-game session ${currentSession.sessionId} (lobby dissolved)`);
        dlog("DISCARD", `session ${currentSession.sessionId} discarded — removegame before game started`, false);
        currentSession = null;
        clearPersistedSession();
        setBadge("", "#666666");
      } else {
        dlog(
          "KT_SOCKET_EVENT",
          `eventName=${ev?.eventName} extractedGameId=${ev?.extractedGameId ?? ""}`,
          false
        );
      }

      // Extract crucible game ID from updategame/newgame lobby events.
      // We only retroactively patch completed sessions — never assign to the
      // current session, because updategame broadcasts ALL active games on the
      // lobby socket and can accidentally pick up a different game's UUID.
      // (The KT_GAMESTATE handler already assigns gs.id from actual gamestates.)
      const extractedId = ev?.extractedGameId;
      if (typeof extractedId === "string" && !currentSession && completedSessions.length > 0) {
        const last = completedSessions[completedSessions.length - 1];
        if (!last.crucibleGameId && last.player1 && last.player2) {
          last.crucibleGameId = extractedId;
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
      console.log(`[KT] KT_DECK_LINK: player=${playerName ?? "?"} deckId=${deckId ?? "?"} deckName=${deckName ?? "?"} hasCurrentSession=${!!currentSession}`);
      dlog(
        "KT_DECK_LINK",
        `player=${playerName ?? "?"} deckId=${deckId ?? "?"} deckName=${deckName ?? "?"}`,
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

    case "KT_LOCAL_USER": {
      const detectedUser = (data as Record<string, unknown>)?.username;
      if (typeof detectedUser === "string" && detectedUser) {
        localPlayer = detectedUser;
        dlog("KT_LOCAL_USER", `detected localPlayer=${detectedUser}`, false);
      }
      break;
    }

    case "KT_STORE_FOUND":
    case "KT_GAME_CHAT":
      if (currentSession) {
        currentSession.events.push(event);
        schedulePersist();
      }
      break;

    case "KT_WS_CLOSE":
    case "KT_PAGE_UNLOAD": {
      dlog(
        type,
        `hasSession=${!!currentSession} gameStarted=${currentSession?.gameStarted ?? false}`,
        false
      );
      if (currentSession && !currentSession.gameStarted) {
        // Page left or WS closed before game started — session was never a real game
        console.log(`[KT] ${type}: discarding pre-game session ${currentSession.sessionId} (never launched)`);
        dlog(
          "DISCARD",
          `session ${currentSession.sessionId} discarded — ${type} before game started`,
          false
        );
        currentSession = null;
        clearPersistedSession();
        setBadge("", "#666666");
      } else if (currentSession) {
        // WS closed mid-game (crash/disconnect) — finalize so the next game
        // can be captured. Winner will be unknown; auto-submit is skipped for
        // unknown winners so nothing bad is submitted.
        console.log(`[KT] ${type}: WS closed mid-game, finalizing session ${currentSession.sessionId}`);
        currentSession.events.push(event);
        finalizeSession("ws_closed_mid_game");
      }
      break;
    }
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

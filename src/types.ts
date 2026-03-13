// Shared types for inject ↔ content ↔ background messaging

export interface TurnTimingEntry {
  turn: number;
  player: string;
  house: string;
  timestamp_ms: number;
}

export interface KeyForgeEvent {
  turn: number;
  player: string;
  key_color: string;
  amber_paid: number;
  timestamp_ms: number;
}

export interface HandCardSnapshot {
  id: string;
  name: string;
  type: string; // "creature" | "action" | "upgrade" | "artifact"
  house: string;
  amber: number; // cardPrintedAmber
  can_play: boolean;
}

export interface BoardCardSnapshot {
  id: string;
  name: string;
  type: string;
  house: string;
  power: number; // modifiedPower
  exhausted: boolean;
  stunned: boolean;
  taunt: boolean;
}

export interface TurnSnapshot {
  turn: number;
  player: string; // who chose the house
  house: string;
  timestamp_ms: number;
  local_hand: HandCardSnapshot[]; // local player's hand only
  boards: Record<string, BoardCardSnapshot[]>; // player name → cardsInPlay
  amber: Record<string, number>;
  deck_size: Record<string, number>;
  discard_size: Record<string, number>;
  archive_size: Record<string, number>;
}

export type InjectEventType =
  | "KT_INJECT_READY"
  | "KT_WS_OPEN"
  | "KT_WS_CLOSE"
  | "KT_SOCKET_EVENT" // generic Socket.IO event
  | "KT_GAMESTATE" // Socket.IO "gamestate" event
  | "KT_GAME_END" // game-over detected in log messages
  | "KT_GAME_CHAT" // chat message
  | "KT_DECK_LINK" // deck UUID extracted from DOM log pane anchor tag
  | "KT_REDUX_STATE" // Redux currentGame state snapshot
  | "KT_STORE_FOUND" // Redux store successfully located
  | "KT_LOCAL_USER"; // local player username detected

export interface InjectMessage {
  source: "KT_INJECT";
  type: InjectEventType;
  timestamp: number;
  data: unknown;
}

// A recorded event within a game session
export interface SessionEvent {
  type: InjectEventType;
  timestamp: number;
  data: unknown;
}

// A complete game session (from first event to game end)
export interface GameSession {
  sessionId: string;
  startTime: number;
  endTime?: number;
  crucibleGameId?: string;
  player1?: string;
  player2?: string;
  winner?: string;
  loser?: string;
  gameStarted?: boolean;
  events: SessionEvent[];
  // Accumulated gamestate snapshots (subset of events for quick access)
  gamestateSnapshots: unknown[];
  // Synthetic log text built at game end (used for submission)
  finalLog?: string;
  gameEndReason?: string;
  // Deck names extracted from pre-game lobby gamestates
  player1DeckName?: string;
  player2DeckName?: string;
  // Deck UUIDs extracted from DOM log pane anchor tags
  player1DeckId?: string;
  player2DeckId?: string;
  // Turn timing extracted from gamestate snapshots
  turnTiming?: TurnTimingEntry[];
  // Key forge events extracted from gamestate snapshots
  keyEvents?: KeyForgeEvent[];
  // Per-turn state snapshots captured at house selection
  turnSnapshots?: TurnSnapshot[];
  // Submission state
  submittedAt?: number;
  submittedGameId?: number;
  submitError?: string;
}

// User-configurable settings
export interface Settings {
  autoSubmit: boolean;
  debugMode: boolean;
}

// One entry in the debug event log (captured regardless of session state)
export interface DebugLogEntry {
  ts: number;
  type: string;
  detail: string; // human-readable summary of key fields
  guardBlocked: boolean; // true if ensureSession returned null for this event
}

// Message from popup → background
export type BackgroundRequest =
  | { type: "GET_STATE" }
  | { type: "DOWNLOAD_SESSION"; sessionId: string }
  | { type: "DOWNLOAD_ALL" }
  | { type: "CLEAR_COMPLETED" }
  | { type: "CLEAR_ALL" }
  | { type: "SUBMIT_SESSION"; sessionId: string }
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: Settings }
  | { type: "GET_DEBUG_LOG" }
  | { type: "CLEAR_DEBUG_LOG" };

// Response from background → popup
export interface BackgroundState {
  currentSession: GameSession | null;
  completedSessions: GameSession[];
  settings: Settings;
}

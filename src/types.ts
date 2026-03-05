// Shared types for inject ↔ content ↔ background messaging

export type InjectEventType =
  | "KT_INJECT_READY"
  | "KT_WS_OPEN"
  | "KT_WS_CLOSE"
  | "KT_SOCKET_EVENT" // generic Socket.IO event
  | "KT_GAMESTATE" // Socket.IO "gamestate" event
  | "KT_GAME_END" // game-over detected in log messages
  | "KT_GAME_CHAT" // chat message
  | "KT_REDUX_STATE" // Redux currentGame state snapshot
  | "KT_STORE_FOUND"; // Redux store successfully located

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
  events: SessionEvent[];
  // Accumulated gamestate snapshots (subset of events for quick access)
  gamestateSnapshots: unknown[];
  // Synthetic log text built at game end (used for submission)
  finalLog?: string;
  gameEndReason?: string;
  // Deck IDs (KF UUIDs) extracted from the first gamestate player objects
  player1DeckId?: string;
  player2DeckId?: string;
  // Submission state
  submittedAt?: number;
  submittedGameId?: number;
  submitError?: string;
}

// User-configurable settings
export interface Settings {
  trackerUrl: string; // e.g. "https://tracker.ancientbearrepublic.com"
  autoSubmit: boolean;
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
  | { type: "SAVE_SETTINGS"; settings: Settings };

// Response from background → popup
export interface BackgroundState {
  currentSession: GameSession | null;
  completedSessions: GameSession[];
  settings: Settings;
}

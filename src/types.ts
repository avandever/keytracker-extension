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
  // Final log array captured at game end
  finalLog?: string[];
  gameEndReason?: string;
}

// Message from popup → background
export type BackgroundRequest =
  | { type: "GET_STATE" }
  | { type: "DOWNLOAD_SESSION"; sessionId: string }
  | { type: "DOWNLOAD_ALL" }
  | { type: "CLEAR_COMPLETED" }
  | { type: "CLEAR_ALL" };

// Response from background → popup
export interface BackgroundState {
  currentSession: GameSession | null;
  completedSessions: GameSession[];
}

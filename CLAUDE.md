# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Manifest V3 Chrome extension that captures KeyForge games played on [thecrucible.online](https://thecrucible.online) in real-time and submits them to the Bear Tracks tracker at `tracker.ancientbearrepublic.com`. Reduces game-reporting friction by auto-capturing game logs, turn timing, key events, and board snapshots.

## Related Projects

- `~/tracker` — the Flask app this extension submits games to (endpoint: `POST /api/v2/upload/extended`)

## Build & Install

```bash
npm install
npm run build        # Build to dist/
npm run dev          # Watch mode (then reload extension manually at chrome://extensions)
npm run type-check   # TypeScript check only
```

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → select `dist/`

The pre-built zip `keytracker-v1.0.zip` is a distributable snapshot.

## Architecture

The extension has 4 entry points operating in different execution worlds:

### 1. `src/inject.ts` — Socket.IO interceptor (MAIN world)
Runs in the **page's JS context** (not the extension sandbox). Patches `window.WebSocket` to intercept Socket.IO frames from thecrucible.online game server.

- Intercepts `42[event_name, payload]` frames
- Handles three Socket.IO events: `gamestate`, win/concede log messages, Redux store snapshots
- Extracts player names, deck UUIDs (from DOM `<a href="...deck-details/UUID">` anchors), winner
- Posts all events to `content.ts` via `window.postMessage({ source: "KT_INJECT", type, data })`

**Gamestate message format quirks:**
- Pre-game: `messages` is a **list** `[{id, date, message:[parts]}]` — deduplicate by `id`
- In-game: `messages` is a **dict** `{"5": [{message:[parts]}], "_t":"a"}` — sort keys numerically, deduplicate by key
- Message parts can be: string, integer (amber costs), or `{name, argType}` object — all three must be handled

### 2. `src/content.ts` — Message relay (ISOLATED world)
Runs in the extension sandbox on thecrucible.online. Receives `postMessage` events from `inject.ts` and forwards them to `background.ts` via `chrome.runtime.sendMessage()`. Simple bridge only.

### 3. `src/background.ts` — Session manager (Service Worker)
The core logic. Accumulates game events, manages session lifecycle, handles persistence.

**Session lifecycle:**
1. New session created when 2+ players seen and post-game guard allows
2. Events accumulated: gamestates, turn timing, key events, turn snapshots
3. Game end detected → session marked complete → badge turns green
4. Popup submits session to tracker via `POST /api/v2/upload/extended`

**Post-game guard:** 90-second timer after game ends. Blocks new session from same player set to prevent phantom sessions from post-game lobby broadcasts. New opponent immediately clears it.

**MV3 service worker persistence:** Service workers are killed and restarted by Chrome. Session data is persisted to `chrome.storage.local` on a 3-second debounced write and restored on restart.

**Log reconstruction for backend submission:**
- Inject `"X brings Y to The Crucible"` and `"X won the flip"` from session metadata (not in captured gamestates)
- Transform forge lines: `"forgedkeyred" → "Red key"`, `"amber" → "Æmber"` to match backend `FORGE_MATCHER`
- Append `"winner has won the game"` if not found (concede/leave games)

**Popup message types** (`BackgroundRequest`):
- `GET_STATE` — current + completed sessions
- `SUBMIT_SESSION` — POST to tracker, returns game ID
- `DOWNLOAD_SESSION` / `DOWNLOAD_ALL` — JSON download
- `CLEAR_COMPLETED` / `CLEAR_ALL`
- `GET_SETTINGS` / `SAVE_SETTINGS`
- `GET_DEBUG_LOG` / `CLEAR_DEBUG_LOG`

### 4. `src/popup/App.tsx` — Popup UI (React + MUI)
Shown when user clicks the extension icon. Auto-refreshes every 2 seconds.
- Shows current session status (event count, snapshot count)
- Lists completed sessions with Submit / Download buttons
- Displays submitted game link (deep link to tracker)
- Settings: autoSubmit toggle, debugMode toggle

## Data Structures (`src/types.ts`)

Key types:
- `GameSession` — full captured game (players, decks, events, timing, snapshots, submittedGameId)
- `TurnTimingEntry` — `{turn, player, house, timestamp_ms}`
- `KeyForgeEvent` — key forge event: `{turn, player, key_color, amber_paid, timestamp_ms}`
- `TurnSnapshot` — full board state: `{turn, player, house, timestamp_ms, local_hand[], boards{}, amber{}, deck/discard/archive sizes}`
- `InjectEventType` — union of all event type strings

## Manifest (`public/manifest.json`)
- MV3
- Permissions: `storage`
- Host permissions: `*://thecrucible.online/*`, `https://tracker.ancientbearrepublic.com/*`
- Content scripts: `inject.js` (MAIN world) + `content.js` (ISOLATED world), both at `document_start`
- Background: `background.js` service worker (module type)

## Build System
- Vite handles popup, background, content scripts
- `inject.ts` is bundled separately via esbuild (`--format=iife --target=chrome111`) because it runs in MAIN world and must not be a module
- Output: all files to `dist/`

## Tracker API Integration

The extension submits to `POST /api/v2/upload/extended` with:
```json
{
  "log": ["line1", "line2", ...],   // reconstructed game log
  "player1": "name",
  "player2": "name",
  "player1_deck_id": "uuid",
  "player2_deck_id": "uuid",
  "turn_timing": [...],
  "key_events": [...],
  "turn_snapshots": [...]
}
```
Response includes `game_id` — stored in `session.submittedGameId`, displayed as a link to `/mui/games/{game_id}`.

## Important Gotchas

- **Service worker lifecycle**: Never assume in-memory state survives — always read from `chrome.storage.local` on startup
- **MAIN world inject**: `inject.js` is built with esbuild iife, not Vite module format. Keep build scripts in sync if adding new MAIN world files
- **Post-game guard**: The 90-second guard is time-based because `handoff` Socket.IO events from lobby are unreliable
- **Player name guard**: Session start requires `playerNames.length >= 2` to block lobby broadcasts and post-game artifacts

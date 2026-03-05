# keytracker-extension

Chromium extension to facilitate uploading game data from thecrucible.online to tracker.ancientbearrepublic.com.

## Status

**Phase 0 — Observer Build**

Captures all game events from thecrucible.online and makes them downloadable as JSON. No data is sent anywhere. Used to map the Crucible's data structures before building the submission pipeline.

---

## Setup

```bash
npm install
npm run build
```

Output lands in `dist/`. Load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `dist/` folder
4. Navigate to thecrucible.online and play a game
5. Click the KeyTracker extension icon to see captured sessions
6. Click **Download** (↓ icon) on any session to get the JSON

---

## Development

```bash
npm run dev        # watch mode (rebuilds on change)
npm run type-check # TypeScript check without build
```

After each `npm run dev` rebuild, go to `chrome://extensions` and click the **↺ reload** button for the extension.

---

## Architecture

```
thecrucible.online page
│
├── inject.js  (world: MAIN — page JS context)
│   • Patches WebSocket constructor to intercept Socket.IO packets
│   • Polls React fiber tree for Redux store, subscribes to changes
│   • Also patches window.io factory as fallback
│   • Sends all events via window.postMessage({ source: "KT_INJECT", ... })
│
├── content.js  (world: ISOLATED — extension context)
│   • Listens for postMessage from inject.js
│   • Forwards to background via chrome.runtime.sendMessage
│
└── background.js  (service worker)
    • Accumulates events into GameSession objects
    • Detects game start (first KT_GAMESTATE) and end (KT_GAME_END)
    • Serves popup requests: GET_STATE, DOWNLOAD_SESSION, DOWNLOAD_ALL
    • Updates extension badge: blue = in game, green = sessions ready

popup.html / popup.js  (popup UI — React + MUI)
    • Shows active game status with live event counts
    • Lists completed sessions with download buttons
    • Auto-refreshes every 2 seconds while open
```

## What to look for in the downloaded JSON

When reviewing a captured session, key fields:

| Field | What it tells us |
|-------|-----------------|
| `crucibleGameId` | Crucible's UUID for this game (stitch key for Phase 3) |
| `player1` / `player2` | Player names extracted from first gamestate |
| `winner` | Winner extracted from log WIN message |
| `gamestateSnapshots[0]` | Full structure of first gamestate — use to map the schema |
| `events[N].type === "KT_SOCKET_EVENT"` | Other Socket.IO events we might want to capture |
| `events[N].type === "KT_REDUX_STATE"` | Redux `currentGame` snapshot (if store found) |

Fields of interest inside a `gamestate` snapshot:
- `players[]` — player objects (look for `name`, `username`, `deck`, `hand`, `archives`)
- `messages[]` — log messages (text, player, type)
- `id` / `gameId` — game UUID
- `activePlayer` — whose turn it is
- `round` — current round
- `winner` / `winReason` — if game is over

---

## Roadmap

| Phase | Goal |
|-------|------|
| **0 (current)** | Observer: capture data, download JSON, map Crucible's API |
| **1** | Auto-submit log to tracker after game ends (no auth, identity from log) |
| **2** | Capture deck card lists, turn timing, Crucible UUID → enrich tracker games |
| **3** | Two-player perspective merge on backend |
| **4** | Turn timeline visualization in tracker frontend |
| **5** | League integration: show pending matchups, one-click submit |

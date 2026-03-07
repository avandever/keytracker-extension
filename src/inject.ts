/**
 * inject.ts — runs in MAIN world (page JavaScript context) via manifest content_scripts.
 *
 * Goals (Phase 0 — Observer):
 *  1. Intercept Socket.IO messages by patching the WebSocket constructor.
 *     Socket.IO v4 frames look like: 42["event_name", {...data}]
 *  2. Try to locate the Redux store via React fiber traversal and subscribe
 *     to currentGame changes.
 *  3. Detect game end from log messages matching the WIN_MATCHER pattern.
 *  4. Relay everything to content.ts via window.postMessage.
 *
 * No Chrome extension APIs are used here — this runs in page context.
 */

(function () {
  "use strict";

  // ─── Messenger ───────────────────────────────────────────────────────────

  function post(type: string, data: unknown): void {
    window.postMessage(
      {
        source: "KT_INJECT",
        type,
        timestamp: Date.now(),
        data,
      },
      "*"
    );
  }

  // ─── Socket.IO / WebSocket Interception ──────────────────────────────────

  // Socket.IO v4 packet format:
  //   "42["event_name", payload]"  — EVENT  (4=MESSAGE, 2=EVENT)
  //   "43["ack_id", payload]"      — ACK
  //   "40"                          — CONNECT
  //   "41"                          — DISCONNECT
  //   "2"                           — PING
  //   "3"                           — PONG

  const SOCKET_IO_EVENT_RE = /^42(\[.*)/s;

  // Crucible message alert parts are [{name, argType}, 'string', ...].
  // Build a plain text string from them.
  function alertPartsToText(parts: unknown[]): string {
    return parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (typeof p === "object" && p !== null) {
          return (p as Record<string, unknown>).name ?? "";
        }
        return "";
      })
      .join("");
  }

  // Iterate new messages in a gamestate delta.
  // messages is a dict like {"423": [{id, date, message}], "_t": "a"}
  function* iterMessages(
    messages: Record<string, unknown>
  ): Generator<string> {
    for (const [key, val] of Object.entries(messages)) {
      if (key === "_t") continue;
      const items = Array.isArray(val) ? val : [val];
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const alertObj = (item as Record<string, unknown>)?.message as
          | Record<string, unknown>
          | undefined;
        const alert = alertObj?.alert as Record<string, unknown> | undefined;
        if (!alert) continue;
        const msgParts = alert.message;
        if (!Array.isArray(msgParts)) continue;
        yield alertPartsToText(msgParts);
      }
    }
  }

  // Track active game UUID (populated from updategame lobby events)
  let activeGameId: string | null = null;
  // Last non-empty player list — used when a gamestate arrives with players={}
  // (Crucible sends empty players at game end, losing context for who played)
  let lastKnownPlayers: string[] = [];

  function handleSocketIoEvent(eventName: string, payload: unknown): void {
    if (eventName === "gamestate") {
      post("KT_GAMESTATE", payload);

      const gs = payload as Record<string, unknown>;
      const players = gs?.players as Record<string, unknown> | undefined;
      const playerNames = players ? Object.keys(players) : [];
      // Keep last known player list so end-of-game messages can use it
      if (playerNames.length > 0) lastKnownPlayers = playerNames;
      const effectivePlayers = playerNames.length > 0 ? playerNames : lastKnownPlayers;

      // Method 1: winner list directly on gamestate
      const winnerList = gs?.winner;
      if (Array.isArray(winnerList) && winnerList.length > 0) {
        post("KT_GAME_END", {
          winner: String(winnerList[0]),
          source: "gamestate.winner",
          gamestate: payload,
        });
        return;
      }

      // Method 2: scan delta messages for win/concede text
      const messages = gs?.messages as Record<string, unknown> | undefined;
      if (messages && typeof messages === "object") {
        for (const text of iterMessages(messages)) {
          // "X has won the game"
          const winMatch = /^(.+) has won the game/.exec(text);
          if (winMatch) {
            post("KT_GAME_END", {
              winner: winMatch[1].trim(),
              rawMessage: text,
              source: "log_win",
              gamestate: payload,
            });
            return;
          }
          // "X concedes" or "X has conceded"
          const concedeMatch = /^(.+?) (?:has )?concede/.exec(text);
          if (concedeMatch) {
            const loser = concedeMatch[1].trim();
            // Use lastKnownPlayers for elimination: the current snapshot may
            // already be missing the loser (they dropped from the player list).
            const winner = lastKnownPlayers.find((n) => n !== loser) ?? "unknown";
            post("KT_GAME_END", {
              winner,
              loser,
              rawMessage: text,
              source: "log_concede",
              gamestate: payload,
            });
            return;
          }
          // "X has left the game" — opponent quit without concede message
          const leftMatch = /^(.+?) has left the game/.exec(text);
          if (leftMatch) {
            const leaver = leftMatch[1].trim();
            const winner = lastKnownPlayers.find((n) => n !== leaver) ?? "unknown";
            post("KT_GAME_END", {
              winner,
              loser: leaver,
              rawMessage: text,
              source: "log_left",
              gamestate: payload,
            });
            return;
          }
        }
      }

      // Method 3: player count drop 2→1 — opponent disconnected without a message
      // Note: players={} (empty) also occurs at game end and mid-game during reconnects,
      // so only trigger on exactly 1 player remaining.
      if (lastKnownPlayers.length === 2 && playerNames.length === 1) {
        post("KT_GAME_END", {
          winner: playerNames[0],
          source: "player_count_drop",
          gamestate: payload,
        });
      }
    } else if (
      eventName === "updategame" ||
      eventName === "newgame"
    ) {
      // Extract active game ID from lobby events
      const items = Array.isArray(payload) ? payload : [payload];
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const g = item as Record<string, unknown>;
        if (g.started === true && typeof g.id === "string") {
          activeGameId = g.id;
          post("KT_SOCKET_EVENT", {
            eventName,
            payload,
            extractedGameId: g.id,
          });
          return;
        }
      }
      post("KT_SOCKET_EVENT", { eventName, payload });
    } else if (eventName === "game chat" || eventName === "chat") {
      post("KT_GAME_CHAT", { eventName, payload });
    } else {
      // Capture all other Socket.IO events so we can map the full protocol
      post("KT_SOCKET_EVENT", { eventName, payload });
    }
  }

  function interceptWebSocket(): void {
    const OrigWS = window.WebSocket;
    if (!OrigWS || (OrigWS as unknown as { _kt: boolean })._kt) return;

    class PatchedWebSocket extends OrigWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);

        const wsUrl =
          typeof url === "string" ? url : url instanceof URL ? url.href : "";
        post("KT_WS_OPEN", { url: wsUrl });

        this.addEventListener("message", (event: MessageEvent) => {
          const raw: unknown = event.data;
          if (typeof raw !== "string") return;

          const match = SOCKET_IO_EVENT_RE.exec(raw);
          if (!match) return;

          try {
            const parsed: unknown = JSON.parse(match[1]);
            if (
              Array.isArray(parsed) &&
              parsed.length >= 2 &&
              typeof parsed[0] === "string"
            ) {
              handleSocketIoEvent(parsed[0] as string, parsed[1]);
            }
          } catch {
            // Not valid JSON, ignore
          }
        });

        this.addEventListener("close", () => {
          post("KT_WS_CLOSE", { url: wsUrl });
        });
      }
    }

    (PatchedWebSocket as unknown as { _kt: boolean })._kt = true;
    Object.defineProperty(window, "WebSocket", {
      value: PatchedWebSocket,
      writable: true,
      configurable: true,
    });
  }

  // ─── Redux Store Finder ──────────────────────────────────────────────────

  function findReduxStoreInFiber(fiber: unknown, depth: number): unknown {
    if (!fiber || depth > 40) return null;
    const f = fiber as Record<string, unknown>;

    // Look for Redux Provider's memoizedState or stateNode
    const ms = f.memoizedState as Record<string, unknown> | null;
    if (ms?.store && typeof (ms.store as Record<string, unknown>).getState === "function") {
      return ms.store;
    }
    const sn = f.stateNode as Record<string, unknown> | null;
    if (sn?.store && typeof (sn.store as Record<string, unknown>).getState === "function") {
      return sn.store;
    }

    return (
      findReduxStoreInFiber(f.child, depth + 1) ||
      findReduxStoreInFiber(f.sibling, depth + 1)
    );
  }

  function findReduxStore(): unknown {
    // Check for explicit global
    const w = window as unknown as Record<string, unknown>;
    if (w.__REDUX_STORE__ && typeof (w.__REDUX_STORE__ as Record<string, unknown>).getState === "function") {
      return w.__REDUX_STORE__;
    }

    // Traverse React fiber tree
    const root = document.querySelector("#root") as Record<string, unknown> | null;
    if (!root) return null;

    const reactKey = Object.keys(root).find(
      (k) =>
        k.startsWith("__reactFiber") ||
        k.startsWith("__reactInternals") ||
        k.startsWith("_reactRootContainer")
    );
    if (!reactKey) return null;

    const fiberOrContainer = root[reactKey] as Record<string, unknown>;
    // React 18: fiber directly; React 16/17: _internalRoot.current
    const internalRoot = fiberOrContainer?._internalRoot as Record<string, unknown> | undefined;
    const rootFiber =
      fiberOrContainer?.current ||
      internalRoot?.current ||
      fiberOrContainer;

    return findReduxStoreInFiber(rootFiber, 0);
  }

  // ─── Redux Subscription ──────────────────────────────────────────────────

  interface ReduxStore {
    getState(): Record<string, unknown>;
    subscribe(listener: () => void): () => void;
  }

  let reduxStore: ReduxStore | null = null;
  let lastCurrentGame: unknown = undefined;

  function attachReduxSubscription(store: ReduxStore): void {
    reduxStore = store;
    post("KT_STORE_FOUND", { found: true });

    store.subscribe(() => {
      const state = store.getState();
      const currentGame =
        (state?.lobby as Record<string, unknown>)?.currentGame ??
        (state?.game as Record<string, unknown>)?.currentGame;

      if (currentGame !== lastCurrentGame) {
        lastCurrentGame = currentGame;
        post("KT_REDUX_STATE", { currentGame });
      }
    });
  }

  // Poll until we find the Redux store (React may not be mounted yet at document_start)
  let pollCount = 0;
  const pollInterval = setInterval(() => {
    pollCount++;
    if (reduxStore) {
      clearInterval(pollInterval);
      return;
    }
    const store = findReduxStore();
    if (store) {
      clearInterval(pollInterval);
      attachReduxSubscription(store as ReduxStore);
    }
    // Give up after ~60 seconds
    if (pollCount > 120) {
      clearInterval(pollInterval);
    }
  }, 500);

  // ─── window.io interception (fallback for older Socket.IO setups) ────────
  // Some pages expose `window.io` as a global. We intercept the factory.

  function patchIoFactory(io: unknown): unknown {
    if (!io || typeof io !== "function") return io;
    const origIo = io as (...args: unknown[]) => unknown;

    function patchedSocket(socket: unknown): unknown {
      if (!socket || typeof socket !== "object") return socket;
      const s = socket as Record<string, unknown>;
      const origOn = s.on as (event: string, handler: (...a: unknown[]) => void) => unknown;
      if (typeof origOn !== "function") return socket;

      s.on = function (event: string, handler: (...a: unknown[]) => void) {
        if (event === "gamestate") {
          return origOn.call(this, event, (data: unknown) => {
            post("KT_GAMESTATE", data);
            handler(data);
          });
        }
        return origOn.call(this, event, handler);
      };
      return socket;
    }

    return function (...args: unknown[]) {
      const socket = origIo(...args);
      return patchedSocket(socket);
    };
  }

  let _io: unknown = (window as unknown as Record<string, unknown>).io;
  if (_io) {
    (window as unknown as Record<string, unknown>).io = patchIoFactory(_io);
  } else {
    Object.defineProperty(window, "io", {
      get() {
        return _io;
      },
      set(val: unknown) {
        _io = patchIoFactory(val);
      },
      configurable: true,
    });
  }

  // ─── DOM Log Pane Observer ───────────────────────────────────────────────
  //
  // The "brings [DeckName] to The Crucible" message is rendered by the
  // Crucible frontend as an <a> tag linking to the deck's page on
  // the Master Vault (or keyforgegame.com). The URL contains the KF deck
  // UUID, which is not available in the Socket.IO gamestate payload.
  //
  // We extract it by watching the DOM for these anchor tags.
  //
  // URL patterns observed in the wild:
  //   https://www.keyforgegame.com/deck-details/UUID
  //   https://keyforgegame.com/deck-details/UUID

  const DECK_LINK_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // Set of UUIDs already reported to avoid duplicates across DOM mutations.
  const reportedDeckLinks = new Set<string>();

  function extractDeckLinkFromAnchor(a: HTMLAnchorElement): void {
    const href = a.href || a.getAttribute("href") || "";
    if (!href.includes("deck-details") && !href.includes("/decks/")) return;

    const match = DECK_LINK_RE.exec(href);
    if (!match) return;

    const deckId = match[0].toLowerCase();
    if (reportedDeckLinks.has(deckId)) return;
    reportedDeckLinks.add(deckId);

    // Try to find the player name from surrounding text.
    // The log message reads: "[PlayerName] brings [DeckName] to The Crucible"
    // Walk up to find the nearest text block containing "brings".
    let playerName: string | null = null;
    let node: Element | null = a;
    for (let depth = 0; depth < 6; depth++) {
      const text = node?.textContent ?? "";
      const m = /^(\S+)\s+brings\b/.exec(text.trim());
      if (m) {
        playerName = m[1];
        break;
      }
      node = node?.parentElement ?? null;
    }

    post("KT_DECK_LINK", {
      deckId,
      deckName: a.textContent?.trim() ?? null,
      playerName,
      href,
    });
  }

  function scanDomForDeckLinks(): void {
    document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
      extractDeckLinkFromAnchor(a);
    });
  }

  function startDomObserver(): void {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          // Check if this node itself is an <a> tag
          if (node.tagName === "A") {
            extractDeckLinkFromAnchor(node as HTMLAnchorElement);
          }
          // Also search within added subtrees
          node.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
            extractDeckLinkFromAnchor(a);
          });
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Scan any links already present in the DOM (e.g., if we injected late)
    scanDomForDeckLinks();
  }

  // Start the observer once the DOM body exists
  if (document.body) {
    startDomObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startDomObserver, {
      once: true,
    });
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────

  interceptWebSocket();
  post("KT_INJECT_READY", {
    url: window.location.href,
    timestamp: Date.now(),
  });
})();

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
  // Game-end patterns from the Crucible log (mirrors WIN_MATCHER in tracker)
  const WIN_RE = /(\w[\w ]*) has won the game/i;

  function handleSocketIoEvent(eventName: string, payload: unknown): void {
    if (eventName === "gamestate") {
      post("KT_GAMESTATE", payload);

      // Try to detect game end from messages array inside gamestate
      const gs = payload as Record<string, unknown>;
      const messages = gs?.messages as Array<Record<string, unknown>>;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          const text =
            (msg?.message as string) ||
            (msg?.text as string) ||
            String(msg?.body ?? "");
          const m = WIN_RE.exec(text);
          if (m) {
            post("KT_GAME_END", {
              winner: m[1],
              rawMessage: text,
              gamestate: payload,
            });
          }
        }
      }
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

  // ─── Bootstrap ───────────────────────────────────────────────────────────

  interceptWebSocket();
  post("KT_INJECT_READY", {
    url: window.location.href,
    timestamp: Date.now(),
  });
})();

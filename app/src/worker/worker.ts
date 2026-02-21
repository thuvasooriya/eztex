// web worker entry point
// dispatches messages to engine.init / engine.compile / engine.clear_cache

import * as engine from "./engine.ts";
import { log, send_status, set_debug, dbg } from "./protocol.ts";

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg.type !== "string") return;

  // enable debug mode if main thread passes debug flag
  if (msg.debug) set_debug(true);

  try {
    switch (msg.type) {
      case "init":
        dbg("worker", "init message received");
        await engine.init();
        break;
      case "compile":
        dbg("worker", `compile: main=${msg.main}, files=${Object.keys(msg.files ?? {}).join(",")}`);
        await engine.compile(msg.files ?? {}, msg.main);
        break;
      case "clear_cache":
        await engine.clear_cache();
        break;
      default:
        log("worker", "warn", `unknown message type: ${msg.type}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("worker", "error", message);
    if (err instanceof Error && err.stack) {
      dbg("worker", `stack: ${err.stack}`);
    }
    send_status("Error", "error");
  }
};

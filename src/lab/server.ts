import { fileURLToPath } from "node:url";
import { sendJson, startBoardServer, type RouteHandler } from "../server/http.js";
import type { Lab } from "./service.js";

export function labRoutes(lab: Lab): RouteHandler {
  return async (req, res, url) => {
    if (url.pathname !== "/api/lab/status") return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Read-only dashboard" });
      return true;
    }
    // Localhost is not authentication; reject foreign browser origins and DNS rebinding hosts.
    const allowed = new Set(["127.0.0.1", "localhost", "[::1]"]);
    const host = new URL(`http://${req.headers.host ?? "invalid"}`).hostname;
    const origin = req.headers.origin;
    let localOrigin = !origin;
    if (origin) {
      try {
        localOrigin = new URL(origin).origin === `http://${req.headers.host}`;
      } catch {
        localOrigin = false;
      }
    }
    if (!allowed.has(host) || !localOrigin) {
      sendJson(res, 403, { error: "Local requests only" });
      return true;
    }
    sendJson(res, 200, lab.snapshot());
    return true;
  };
}

export function startLabBoard(lab: Lab, port: number) {
  return startBoardServer({
    candidates: [port],
    uiDir: fileURLToPath(new URL("../../ui_dist/", import.meta.url)),
    routes: [labRoutes(lab)],
    onError: (message) => console.error(message),
  });
}

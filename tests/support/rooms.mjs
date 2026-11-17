import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
const root = fileURLToPath(new URL("../../", import.meta.url));
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function launch(t, worker, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "coshop-phase1-")),
    port = Number(extra.TEST_PORT || (worker ? 14295 : 14294));
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: directory,
    INVITE_SIGNING_SECRET: "test-secret-not-for-production-0123456789",
    JOIN_LIMIT_PER_10_MIN: "500",
    CREATE_LIMIT_PER_HOUR: "100",
    WRANGLER_SEND_METRICS: "false",
    ...extra,
  };
  const bindings = [
    "INVITE_SIGNING_SECRET",
    "JOIN_LIMIT_PER_10_MIN",
    "CREATE_LIMIT_PER_HOUR",
    "ROOM_TTL_MS",
    "SEAT_RESERVATION_MS",
    "HEARTBEAT_INTERVAL_MS",
    "HEARTBEAT_TIMEOUT_MS",
    "PRESENCE_IDLE_MS",
  ]
    .filter((key) => env[key])
    .flatMap((key) => ["--var", key + ":" + env[key]]);
  const args = worker
    ? [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--port",
        String(port),
        "--ip",
        "127.0.0.1",
        // Keep parallel Wrangler instances off the shared devtools port.
        "--inspector-port",
        String(port + 1000),
        "--persist-to",
        directory,
        ...bindings,
      ]
    : ["server.mjs"];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  t.after(async () => {
    child.kill();
    if (child.exitCode === null)
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(2500),
      ]);
    assert.ok(directory.startsWith(join(tmpdir(), "coshop-phase1-")));
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {}
  });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error("Server exited: " + output);
    try {
      if ((await fetch(base)).status === 200) return { base, child };
    } catch {}
    await delay(200);
  }
  throw new Error("Server did not start: " + output);
}

export async function api(base, path, body, token) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    data: await response.json(),
    headers: response.headers,
  };
}
export function socket(base, invite, token) {
  const ws = new WebSocket(
    base.replace("http:", "ws:") + "/api/rooms/" + invite + "/socket",
    { origin: base },
  );
  const messages = [];
  ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  ws.on("error", () => {});
  const wait = async (predicate) => {
    for (let n = 0; n < 150; n++) {
      const found = messages.find(predicate);
      if (found) return found;
      await delay(20);
    }
    throw new Error("Missing websocket message: " + JSON.stringify(messages));
  };
  return { ws, messages, wait };
}

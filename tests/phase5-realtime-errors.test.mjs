import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { errorMessage } from "../server/realtime.js";
import { RoomError } from "../server/config.js";
import { api, delay, launch } from "./support/rooms.mjs";

test("only RoomError details reach clients", () => {
  const internal = Object.assign(
    new Error("UNIQUE constraint failed: connections.id"),
    { code: "ERR_SQLITE_ERROR" },
  );
  assert.deepEqual(errorMessage(internal), {
    type: "error",
    code: "SERVER_ERROR",
    message: "Something went wrong. Your room is safe; please retry.",
  });
  assert.equal(
    errorMessage(new RoomError("CHECKOUT_BUSY", "Locked.", 409)).code,
    "CHECKOUT_BUSY",
  );
});

test("Node: frames rejected during authentication do not release the auth guard", { timeout: 30000 }, async (t) => {
  const { base } = await launch(t, false, { TEST_PORT: "14361" });
  const made = await api(base, "/api/rooms", {
    name: "Maya",
    avatar: "sage",
    catalogMode: "sample",
  });
  const ws = new WebSocket(
    base.replace("http:", "ws:") + "/api/rooms/" + made.data.invite + "/socket",
    { origin: base },
  );
  t.after(() => ws.close());
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  await new Promise((resolve) => ws.on("open", resolve));
  const auth = JSON.stringify({ type: "auth", token: made.data.token });
  ws.send(auth);
  ws.send(JSON.stringify({ type: "heartbeat" }));
  ws.send(auth);
  ws.send(auth);
  await delay(800);
  const errors = messages.filter((message) => message.type === "error");
  assert.ok(errors.length >= 1);
  assert.deepEqual(new Set(errors.map((error) => error.code)), new Set(["INVALID_MESSAGE"]));
  assert.equal(JSON.stringify(messages).includes("SQLITE"), false);
  assert.equal(messages.filter((message) => message.type === "state").length, 1);
  ws.send(JSON.stringify({ type: "heartbeat" }));
  await delay(200);
  assert.equal(messages.at(-1).type, "pong");
});

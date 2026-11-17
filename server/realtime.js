import { RoomError } from "./config.js";
export const errorMessage = (error) => ({
  type: "error",
  code: error.code || "SERVER_ERROR",
  message: error.code
    ? error.message
    : "Something went wrong. Your room is safe; please retry.",
  retryAfter: error.retryAfter,
});
export function parseMessage(raw) {
  if (typeof raw !== "string" || raw.length > 2048)
    throw new RoomError("INVALID_MESSAGE", "Invalid connection message.");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new RoomError("INVALID_MESSAGE", "Invalid connection message.");
  }
}
export const stateMessage = (rooms, id, me) => ({
  type: "state",
  room: rooms.snapshot(id),
  ...(me ? { me } : {}),
});

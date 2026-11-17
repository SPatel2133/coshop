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
// Room snapshots are reserved for membership changes and reconnects. Navigation
// and idle changes broadcast a small participant delta, never a whole catalog.
export function presenceChanges(room, cache) {
  const previous = cache.get(room.id);
  const membership = JSON.stringify(
    room.participants.map((p) => [p.id, p.connected]),
  );
  const signatures = new Map();
  const messages = [];
  for (const participant of room.participants) {
    const signature = JSON.stringify([
      participant.name,
      participant.avatar,
      participant.connected,
      participant.away,
      participant.view?.eventId,
    ]);
    signatures.set(participant.id, signature);
    if (previous?.signatures.get(participant.id) !== signature)
      messages.push({
        type: "presence",
        participant,
        version: room.version,
        expiresAt: room.expiresAt,
        serverTime: room.serverTime,
      });
  }
  cache.set(room.id, { membership, signatures });
  return {
    membershipChanged: Boolean(previous && membership !== previous.membership),
    messages,
  };
}

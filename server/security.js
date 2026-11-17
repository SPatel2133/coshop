import { RoomError } from "./config.js";
const encoder = new TextEncoder();
const hex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export const newToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
export async function sign(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
export async function makeInvite(secret, id) {
  return id + "." + (await sign(secret, "invite:" + id));
}
export async function verifyInvite(secret, invite) {
  if (
    typeof invite !== "string" ||
    !/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(invite)
  )
    throw new RoomError("INVALID_LINK", "This invite link is invalid.", 404);
  const [id, signature] = invite.split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.match(/../g), (h) => parseInt(h, 16));
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      encoder.encode("invite:" + id),
    ))
  )
    throw new RoomError("INVALID_LINK", "This invite link is invalid.", 404);
  return id;
}
export async function tokenHash(value) {
  if (
    typeof value !== "string" ||
    !/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(value)
  )
    throw new RoomError(
      "INVALID_SESSION",
      "Your saved session is not valid. Join with a name to get a new identity.",
      401,
    );
  return digest(value);
}
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new RoomError(
      "ORIGIN_DENIED",
      "Open the room on its own website.",
      403,
    );
}
export function nodeRequestUrl(request, publicOrigin) {
  // A tunnel terminates HTTPS before forwarding to local HTTP. Use only the
  // explicitly configured public host; never trust arbitrary forwarded headers.
  const publicUrl = publicOrigin ? new URL(publicOrigin) : null;
  const origin =
    publicUrl?.host === request.headers.host
      ? publicUrl.origin
      : "http://" + request.headers.host;
  const url = new URL(request.url, origin);
  if (url.origin !== origin)
    throw new RoomError("INVALID_REQUEST", "Invalid request target.", 400);
  return url;
}

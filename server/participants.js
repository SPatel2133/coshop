import { RoomError } from "./config.js";
export const AVATARS = ["sage", "clay", "butter", "lilac", "sky", "rose"];
export function displayName(input) {
  const name = String(input ?? "")
    .normalize("NFC")
    .trim()
    .replace(/ +/g, " ");
  if (
    !name ||
    [...name].length > 32 ||
    !/^[\p{L}\p{M}\p{N} .’'_-]+$/u.test(name)
  )
    throw new RoomError(
      "INVALID_NAME",
      "Use 1–32 letters or numbers. Spaces, apostrophes, periods, hyphens and underscores are welcome.",
    );
  return name;
}
export function avatar(input) {
  if (!AVATARS.includes(input))
    throw new RoomError("INVALID_AVATAR", "Choose one of the six avatars.");
  return input;
}
export function roomName(input) {
  const name = String(input ?? "")
    .normalize("NFC")
    .trim()
    .replace(/ +/g, " ");
  if ([...name].length > 60 || /[<>\p{Cc}\p{Cf}]/u.test(name))
    throw new RoomError(
      "INVALID_ROOM_NAME",
      "Room names can contain up to 60 characters, without HTML or control characters.",
    );
  return name || "A little shopping together";
}
export function uniqueName(name, occupied) {
  const names = new Set(occupied.map((n) => n.toLocaleLowerCase("en")));
  if (!names.has(name.toLocaleLowerCase("en"))) return name;
  for (let n = 2; ; n++) {
    const suffix = " " + n;
    const candidate = [...name].slice(0, 32 - suffix.length).join("") + suffix;
    if (!names.has(candidate.toLocaleLowerCase("en"))) return candidate;
  }
}

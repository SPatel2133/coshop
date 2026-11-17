const query = new URLSearchParams(location.search);
export const guest = query.get("guest");
let storage;
try {
  storage = guest ? sessionStorage : localStorage;
} catch {
  storage = null;
}
const key = (invite) => "coshop:session:" + invite + (guest ? ":" + guest : "");
export function loadSession(invite) {
  try {
    return JSON.parse(storage?.getItem(key(invite)) || "null");
  } catch {
    return null;
  }
}
export function saveSession(invite, session) {
  try {
    storage.setItem(key(invite), JSON.stringify(session));
  } catch {
    throw new Error(
      "Browser storage is blocked. Allow storage for coshop so refreshing keeps your identity.",
    );
  }
}
export function clearSession(invite) {
  try {
    storage.removeItem(key(invite));
  } catch {}
}
export function canSaveSession() {
  const test = "coshop:storage-test";
  try {
    storage.setItem(test, "1");
    storage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

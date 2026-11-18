export function roomUrl(path) {
  const configured = import.meta.env?.VITE_ROOM_BACKEND_ORIGIN;
  if (!configured) return new URL(path, location.origin);
  const backend = new URL(configured);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname);
  if (
    configured !== backend.origin ||
    (backend.protocol !== "https:" && !(loopback && backend.protocol === "http:"))
  ) throw new Error("VITE_ROOM_BACKEND_ORIGIN must be an HTTPS origin.");
  return new URL(path, backend);
}

import { RoomError } from "./config.js";
import { sign } from "./security.js";
export function ratePolicy(config, kind) {
  return kind === "create"
    ? { limit: config.createLimit, window: 3600000 }
    : { limit: config.joinLimit, window: 600000 };
}
export async function rateKey(config, ip, kind, now = Date.now()) {
  const policy = ratePolicy(config, kind),
    start = Math.floor(now / policy.window) * policy.window;
  return {
    id: await sign(config.secret, `abuse:${kind}:${start}:${ip}`),
    expires: start + policy.window,
    ...policy,
  };
}
export function consume(store, bucket, now = Date.now()) {
  const count = store.transaction(() => {
    store.run("DELETE FROM abuse_windows WHERE expires_at<=?", now);
    store.run(
      "INSERT INTO abuse_windows(id,count,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1",
      bucket.id,
      bucket.expires,
    );
    return store.all("SELECT count FROM abuse_windows WHERE id=?", bucket.id)[0]
      .count;
  });
  if (count > bucket.limit)
    throw new RoomError(
      "RATE_LIMITED",
      "Too many attempts. Give it a moment, then try again.",
      429,
      Math.max(1, Math.ceil((bucket.expires - now) / 1000)),
    );
}

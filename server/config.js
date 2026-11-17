export class RoomError extends Error {
  constructor(code, message, status = 400, retryAfter) {
    super(message);
    Object.assign(this, { code, status, retryAfter });
  }
}
const positive = (env, key, fallback) => {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid ${key}`);
  return value;
};
export function configuration(env = {}) {
  const secret = env.INVITE_SIGNING_SECRET;
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error(
      "INVITE_SIGNING_SECRET must contain at least 32 characters.",
    );
  return {
    secret,
    ttl: positive(env, "ROOM_TTL_MS", 86400000),
    reservation: positive(env, "SEAT_RESERVATION_MS", 600000),
    heartbeat: positive(env, "HEARTBEAT_INTERVAL_MS", 20000),
    heartbeatTimeout: positive(env, "HEARTBEAT_TIMEOUT_MS", 65000),
    presenceIdle: positive(env, "PRESENCE_IDLE_MS", 30000),
    createLimit: positive(env, "CREATE_LIMIT_PER_HOUR", 10),
    joinLimit: positive(env, "JOIN_LIMIT_PER_10_MIN", 60),
    shopify: {
      domain: env.SHOPIFY_STORE_DOMAIN || "",
      token: env.SHOPIFY_STOREFRONT_TOKEN || "",
      apiVersion: env.SHOPIFY_API_VERSION || "",
      country: env.SHOPIFY_BUYER_COUNTRY || "",
    },
  };
}

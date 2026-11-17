CREATE TABLE room_storefronts (
  room_id TEXT PRIMARY KEY REFERENCES room_records(id) ON DELETE CASCADE,
  store_key TEXT NOT NULL,
  catalog TEXT NOT NULL,
  bag_checks TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE checkout_leases (
  room_id TEXT PRIMARY KEY REFERENCES room_records(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
INSERT INTO schema_migrations(version) VALUES(6);

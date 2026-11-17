CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS room_records (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  seat_until INTEGER NOT NULL,
  UNIQUE(room_id, token_hash)
);
CREATE INDEX IF NOT EXISTS participants_room ON participants(room_id);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_room ON connections(room_id);
CREATE TABLE IF NOT EXISTS abuse_windows (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);

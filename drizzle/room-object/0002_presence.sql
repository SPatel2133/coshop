ALTER TABLE connections ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  product_id TEXT,
  variant_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('view','hold_up','add_to_bag','remove_from_bag','react')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_latest_view ON events(room_id,user_id,type,sequence DESC);
INSERT INTO schema_migrations(version) VALUES (2);

CREATE TABLE haul_checkouts (
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  shop TEXT NOT NULL,
  cart_token TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (room_id,id)
);
CREATE TABLE haul_recaps (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(room_id,event_key)
);
CREATE INDEX haul_room_history ON haul_recaps(room_id,sequence DESC);
INSERT INTO schema_migrations(version) VALUES(7);

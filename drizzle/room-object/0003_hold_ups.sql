CREATE TABLE bag_lines (
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
  picked_by TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, variant_id)
);
CREATE INDEX events_room_type_sequence ON events(room_id, type, sequence);
INSERT INTO schema_migrations(version) VALUES(3);

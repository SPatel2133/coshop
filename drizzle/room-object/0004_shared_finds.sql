CREATE INDEX events_shared_variants ON events(room_id, type, variant_id, sequence);
CREATE TABLE shared_finds (
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,
  first_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  latest_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY(room_id, variant_id)
);
INSERT INTO shared_finds(room_id,variant_id,first_event_id,latest_event_id)
SELECT e.room_id,e.variant_id,e.id,
  (SELECT last.id FROM events last WHERE last.room_id=e.room_id AND last.variant_id=e.variant_id AND last.type='hold_up' ORDER BY last.sequence DESC LIMIT 1)
FROM events e WHERE e.type='hold_up' AND e.variant_id IS NOT NULL AND e.sequence=
  (SELECT MIN(first.sequence) FROM events first WHERE first.room_id=e.room_id AND first.variant_id=e.variant_id AND first.type='hold_up');
INSERT INTO schema_migrations(version) VALUES(4);

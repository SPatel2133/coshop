CREATE TABLE discussion_entries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  find_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  text TEXT,
  score INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((text IS NOT NULL AND score IS NULL) OR
    (text IS NULL AND find_id IS NOT NULL AND score IS NOT NULL AND score BETWEEN 1 AND 5))
);
CREATE INDEX discussion_history ON discussion_entries(room_id,find_id,sequence DESC) WHERE text IS NOT NULL;
CREATE INDEX discussion_writer ON discussion_entries(room_id,user_id,(text IS NULL),sequence DESC);
CREATE TABLE find_ratings (
  room_id TEXT NOT NULL REFERENCES room_records(id) ON DELETE CASCADE,
  find_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  PRIMARY KEY(room_id,find_id,user_id)
);
INSERT INTO schema_migrations(version) VALUES (5);

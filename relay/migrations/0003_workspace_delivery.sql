ALTER TABLE messages ADD COLUMN collapse_key TEXT;
CREATE UNIQUE INDEX messages_collapse ON messages(pair_id, collapse_key);

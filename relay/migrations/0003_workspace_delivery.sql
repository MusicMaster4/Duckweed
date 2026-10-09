ALTER TABLE messages ADD COLUMN collapse_key TEXT;
-- Historical deliveries have no state key. Index only replaceable state so a
-- nearly full production database can migrate without indexing its backlog.
CREATE UNIQUE INDEX messages_collapse ON messages(pair_id, collapse_key) WHERE collapse_key IS NOT NULL;

CREATE TABLE pairings (
  pair_id TEXT PRIMARY KEY NOT NULL,
  registration_token_hash TEXT NOT NULL,
  send_token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  device_id TEXT,
  device_name TEXT,
  device_proof TEXT,
  fcm_token TEXT,
  receive_token_hash TEXT,
  paired_at INTEGER,
  token_updated_at INTEGER
);

CREATE TABLE messages (
  pair_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_nonce TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (pair_id, message_id),
  FOREIGN KEY (pair_id) REFERENCES pairings(pair_id) ON DELETE CASCADE
);

CREATE INDEX messages_expiry ON messages(expires_at);
CREATE INDEX pairings_expiry ON pairings(expires_at) WHERE device_id IS NULL;

CREATE TABLE pairing_rate_limits (
  source_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (source_hash, window_start)
);

CREATE INDEX pairing_rate_limit_expiry ON pairing_rate_limits(window_start);

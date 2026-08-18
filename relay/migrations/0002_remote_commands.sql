CREATE TABLE commands (
  pair_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_nonce TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (pair_id, command_id),
  FOREIGN KEY (pair_id) REFERENCES pairings(pair_id) ON DELETE CASCADE
);

CREATE INDEX commands_expiry ON commands(expires_at);
CREATE INDEX commands_pending ON commands(pair_id, created_at);

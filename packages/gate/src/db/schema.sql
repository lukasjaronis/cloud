DROP TABLE IF EXISTS keys;
DROP TABLE IF EXISTS rate_limits;

CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT,
  hash TEXT,
  expires INT NULL,
  uses INT NULL,
  metadata TEXT NULL
);
CREATE INDEX idx_keys_id ON keys (id);
CREATE INDEX idx_keys_slug ON keys (slug);

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyID INTEGER,
  maxTokens INT,
  tokens INT,
  refillRate INT, 
  refillInterval INT,
  lastFilled TIMESTAMP,
  FOREIGN KEY (keyID) REFERENCES keys(id)
);
CREATE INDEX idx_rate_limits_keyId ON rate_limits (keyID);
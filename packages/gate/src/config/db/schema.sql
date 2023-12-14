DROP TABLE IF EXISTS keys;

CREATE TABLE IF NOT EXISTS keys (
  id VARCHAR(256) PRIMARY KEY NOT NULL,
  slug VARCHAR(256) NOT NULL,
  hash VARCHAR(256) NOT NULL,
  expires INT,
  uses INT,
  metadata TEXT,
  maxTokens INT,
  tokens INT,
  refillRate INT,
  refillInterval INT
);

CREATE INDEX idx_keys_hash ON keys (hash);
CREATE INDEX idx_keys_slug ON keys (slug);
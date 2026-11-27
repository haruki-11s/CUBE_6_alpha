-- CUBE 6 online: players, finished games and the ranking tallies.
-- No personal data: a player is a random id, the hash of a random key and a number for the name.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,          -- SHA-256 of the key; the key itself is never stored
  num INTEGER NOT NULL UNIQUE,     -- the name: PLAYER-<num, 5 digits>
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);

CREATE TABLE games (
  id TEXT PRIMARY KEY,             -- <room>:<game number in the room>
  kind TEXT NOT NULL,              -- random / code
  player_o TEXT,                   -- NULL once that player deleted their data
  player_x TEXT,
  winner TEXT,                     -- O / X / NULL (called off)
  reason TEXT NOT NULL,
  plies INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  ranked INTEGER NOT NULL DEFAULT 0 -- 1: the win counted for the rankings
);
CREATE INDEX games_by_o ON games (player_o, ended_at);
CREATE INDEX games_by_x ON games (player_x, ended_at);

CREATE TABLE wins (
  period TEXT NOT NULL,            -- daily:<start ms> / weekly:<start ms>
  player_id TEXT NOT NULL,
  wins INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,     -- who reached that many wins first is listed first
  PRIMARY KEY (period, player_id)
);
CREATE INDEX wins_by_rank ON wins (period, wins DESC, updated_at);

-- new players per address and hour, for the sign-up limit (the address is hashed with a secret salt)
CREATE TABLE signups (
  bucket INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (bucket, ip_hash)
);

-- 誤審の訂正 that broke a 詰み: the judge was wrong; kept to find the bug
CREATE TABLE judge_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  ply INTEGER NOT NULL,
  board TEXT NOT NULL,
  turn TEXT NOT NULL,
  at INTEGER NOT NULL
);

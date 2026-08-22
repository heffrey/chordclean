-- One row per day, holding a tally of successful cleans.
--
-- There is deliberately no visitor column, no IP, no user agent, and no
-- session id. The site promises that nothing about a visitor's PDF is kept,
-- and a schema with nowhere to put such data is a stronger guarantee than a
-- promise not to write it.
CREATE TABLE IF NOT EXISTS cleans (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);

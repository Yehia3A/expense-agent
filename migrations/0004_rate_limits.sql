-- Fixed-window request counters for rate limiting (Phase 3).
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,           -- e.g. chat:min, chat:day, api:min
  window_start INTEGER NOT NULL,  -- unix seconds, aligned to the window size
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

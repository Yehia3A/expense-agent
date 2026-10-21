-- Each account's city and time zone (D46): "today", months and history
-- follow it. Existing accounts keep Cairo, which is what they used so far.
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Africa/Cairo';
ALTER TABLE users ADD COLUMN city TEXT;

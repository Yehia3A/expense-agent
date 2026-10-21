-- Multi-user (D34): every row of personal data belongs to one account.
-- Existing rows become 'unclaimed' (invisible to everyone) until the owner
-- runs `npm run claim:remote -- <username>` after creating their account,
-- so nobody who signs up first can inherit them.
PRAGMA defer_foreign_keys = true;

CREATE TABLE expenses_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  category TEXT NOT NULL REFERENCES categories(key),
  expense_date TEXT NOT NULL,
  note TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (user_id, request_id, line_index)
);
INSERT INTO expenses_new (id, user_id, amount, currency, category, expense_date, note, needs_review, source, request_id, line_index, created_at, deleted_at)
  SELECT id, 'unclaimed', amount, currency, category, expense_date, note, needs_review, source, request_id, line_index, created_at, deleted_at FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX idx_expenses_user_date ON expenses (user_id, expense_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_expenses_user_request ON expenses (user_id, request_id);

CREATE TABLE budgets_new (
  user_id TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES categories(key),
  month TEXT NOT NULL,
  amount REAL,
  PRIMARY KEY (user_id, category, month)
);
INSERT INTO budgets_new (user_id, category, month, amount) SELECT 'unclaimed', category, month, amount FROM budgets;
DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;

CREATE TABLE legacy_new (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES categories(key),
  amount REAL NOT NULL,
  PRIMARY KEY (user_id, month, category)
);
INSERT INTO legacy_new (user_id, month, category, amount) SELECT 'unclaimed', month, category, amount FROM legacy_monthly_totals;
DROP TABLE legacy_monthly_totals;
ALTER TABLE legacy_new RENAME TO legacy_monthly_totals;

-- Merchant cache: user_id '' is the shared starting vocabulary; each account
-- learns its own words on top of it.
CREATE TABLE merchant_new (
  user_id TEXT NOT NULL,
  term TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES categories(key),
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, term)
);
INSERT INTO merchant_new (user_id, term, category, hits, updated_at)
  SELECT CASE WHEN updated_at = '2026-10-20' THEN '' ELSE 'unclaimed' END, term, category, hits, updated_at FROM merchant_map;
INSERT OR IGNORE INTO merchant_new (user_id, term, category, hits, updated_at) VALUES
  ('', 'coffee', 'food_dining', 1, '2026-10-20'),
  ('', 'lunch', 'food_dining', 1, '2026-10-20'),
  ('', 'dinner', 'food_dining', 1, '2026-10-20'),
  ('', 'breakfast', 'food_dining', 1, '2026-10-20'),
  ('', 'restaurant', 'food_dining', 1, '2026-10-20'),
  ('', 'pizza', 'food_dining', 1, '2026-10-20'),
  ('', 'burger', 'food_dining', 1, '2026-10-20'),
  ('', 'koshary', 'food_dining', 1, '2026-10-20'),
  ('', 'shawarma', 'food_dining', 1, '2026-10-20'),
  ('', 'talabat', 'food_dining', 1, '2026-10-20'),
  ('', 'snack', 'food_dining', 1, '2026-10-20'),
  ('', 'snacks', 'food_dining', 1, '2026-10-20'),
  ('', 'tea', 'food_dining', 1, '2026-10-20'),
  ('', 'ahwa', 'food_dining', 1, '2026-10-20'),
  ('', 'starbucks', 'food_dining', 1, '2026-10-20'),
  ('', 'vegs', 'groceries', 1, '2026-10-20'),
  ('', 'veggies', 'groceries', 1, '2026-10-20'),
  ('', 'vegetables', 'groceries', 1, '2026-10-20'),
  ('', 'fruit', 'groceries', 1, '2026-10-20'),
  ('', 'fruits', 'groceries', 1, '2026-10-20'),
  ('', 'supermarket', 'groceries', 1, '2026-10-20'),
  ('', 'groceries', 'groceries', 1, '2026-10-20'),
  ('', 'meat', 'groceries', 1, '2026-10-20'),
  ('', 'chicken', 'groceries', 1, '2026-10-20'),
  ('', 'bread', 'groceries', 1, '2026-10-20'),
  ('', 'milk', 'groceries', 1, '2026-10-20'),
  ('', 'eggs', 'groceries', 1, '2026-10-20'),
  ('', 'carrefour', 'groceries', 1, '2026-10-20'),
  ('', 'uber', 'transport_fuel', 1, '2026-10-20'),
  ('', 'careem', 'transport_fuel', 1, '2026-10-20'),
  ('', 'indrive', 'transport_fuel', 1, '2026-10-20'),
  ('', 'taxi', 'transport_fuel', 1, '2026-10-20'),
  ('', 'metro', 'transport_fuel', 1, '2026-10-20'),
  ('', 'fuel', 'transport_fuel', 1, '2026-10-20'),
  ('', 'benzine', 'transport_fuel', 1, '2026-10-20'),
  ('', 'gas station', 'transport_fuel', 1, '2026-10-20'),
  ('', 'parking', 'transport_fuel', 1, '2026-10-20'),
  ('', 'toll', 'transport_fuel', 1, '2026-10-20'),
  ('', 'electricity', 'bills_utilities', 1, '2026-10-20'),
  ('', 'electricity bill', 'bills_utilities', 1, '2026-10-20'),
  ('', 'water bill', 'bills_utilities', 1, '2026-10-20'),
  ('', 'gas bill', 'bills_utilities', 1, '2026-10-20'),
  ('', 'internet', 'bills_utilities', 1, '2026-10-20'),
  ('', 'wifi', 'bills_utilities', 1, '2026-10-20'),
  ('', 'phone credit', 'bills_utilities', 1, '2026-10-20'),
  ('', 'mobile recharge', 'bills_utilities', 1, '2026-10-20'),
  ('', 'cinema', 'entertainment', 1, '2026-10-20'),
  ('', 'movie', 'entertainment', 1, '2026-10-20'),
  ('', 'netflix', 'entertainment', 1, '2026-10-20'),
  ('', 'spotify', 'entertainment', 1, '2026-10-20'),
  ('', 'shahid', 'entertainment', 1, '2026-10-20'),
  ('', 'playstation', 'entertainment', 1, '2026-10-20'),
  ('', 'clothes', 'shopping', 1, '2026-10-20'),
  ('', 'shoes', 'shopping', 1, '2026-10-20'),
  ('', 'shirt', 'shopping', 1, '2026-10-20'),
  ('', 'tshirt', 'shopping', 1, '2026-10-20'),
  ('', 'amazon', 'shopping', 1, '2026-10-20'),
  ('', 'squash', 'sports', 1, '2026-10-20'),
  ('', 'squash court', 'sports', 1, '2026-10-20'),
  ('', 'gym', 'sports', 1, '2026-10-20'),
  ('', 'padel', 'sports', 1, '2026-10-20'),
  ('', 'racket', 'sports', 1, '2026-10-20'),
  ('', 'thndr', 'other', 1, '2026-10-20'),
  ('', 'index fund', 'other', 1, '2026-10-20'),
  ('', 'gold', 'other', 1, '2026-10-20'),
  ('', 'bitcoin', 'other', 1, '2026-10-20'),
  ('', 'btc', 'other', 1, '2026-10-20'),
  ('', 'binance', 'other', 1, '2026-10-20'),
  ('', 'crypto', 'other', 1, '2026-10-20');
DROP TABLE merchant_map;
ALTER TABLE merchant_new RENAME TO merchant_map;

ALTER TABLE logs ADD COLUMN user_id TEXT;
CREATE INDEX idx_logs_user_request ON logs (user_id, request_id);

-- Personal API tokens for MCP clients and scripts (one per account; only the SHA-256 is kept).
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

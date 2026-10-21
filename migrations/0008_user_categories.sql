-- Per-user categories (D41): each account picks or writes its own categories
-- (up to 10, plus an automatic 'other') with a monthly budget each. The fixed
-- global list goes away, so the foreign keys to it go too.
PRAGMA defer_foreign_keys = true;

CREATE TABLE user_categories (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,              -- stable id stored on expenses ([a-z0-9_]); renaming keeps it
  name TEXT NOT NULL,             -- what the user sees and types
  sort_order INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,  -- 0 = removed but still has history
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Data from before accounts keeps its old categories; `npm run claim:*` moves them with it.
INSERT INTO user_categories (user_id, key, name, sort_order, created_at)
  SELECT 'unclaimed', key, display_name, sort_order, '2026-10-21' FROM categories;

CREATE TABLE expenses_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  category TEXT NOT NULL,
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
  SELECT id, user_id, amount, currency, category, expense_date, note, needs_review, source, request_id, line_index, created_at, deleted_at FROM expenses;
DROP TABLE expenses;
ALTER TABLE expenses_new RENAME TO expenses;
CREATE INDEX idx_expenses_user_date ON expenses (user_id, expense_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_expenses_user_request ON expenses (user_id, request_id);

CREATE TABLE budgets_new (
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  month TEXT NOT NULL,
  amount REAL,
  PRIMARY KEY (user_id, category, month)
);
INSERT INTO budgets_new (user_id, category, month, amount) SELECT user_id, category, month, amount FROM budgets;
DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;

CREATE TABLE legacy_new (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (user_id, month, category)
);
INSERT INTO legacy_new (user_id, month, category, amount) SELECT user_id, month, category, amount FROM legacy_monthly_totals;
DROP TABLE legacy_monthly_totals;
ALTER TABLE legacy_new RENAME TO legacy_monthly_totals;

CREATE TABLE merchant_new (
  user_id TEXT NOT NULL,
  term TEXT NOT NULL,
  category TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, term)
);
INSERT INTO merchant_new (user_id, term, category, hits, updated_at) SELECT user_id, term, category, hits, updated_at FROM merchant_map;
DROP TABLE merchant_map;
ALTER TABLE merchant_new RENAME TO merchant_map;

DROP TABLE categories;

-- Shared starting vocabulary for the suggested categories. A word only
-- applies to accounts that have that category; everything else goes to the
-- LLM and is learned per account.
UPDATE merchant_map SET category = 'investments' WHERE user_id = '' AND category = 'other';
INSERT OR IGNORE INTO merchant_map (user_id, term, category, hits, updated_at) VALUES
  ('', 'rent', 'rent_housing', 1, '2026-10-21'),
  ('', 'landlord', 'rent_housing', 1, '2026-10-21'),
  ('', 'maintenance fee', 'rent_housing', 1, '2026-10-21'),
  ('', 'pharmacy', 'health', 1, '2026-10-21'),
  ('', 'medicine', 'health', 1, '2026-10-21'),
  ('', 'doctor', 'health', 1, '2026-10-21'),
  ('', 'dentist', 'health', 1, '2026-10-21'),
  ('', 'clinic', 'health', 1, '2026-10-21'),
  ('', 'tuition', 'education', 1, '2026-10-21'),
  ('', 'course', 'education', 1, '2026-10-21'),
  ('', 'books', 'education', 1, '2026-10-21'),
  ('', 'udemy', 'education', 1, '2026-10-21'),
  ('', 'hotel', 'travel', 1, '2026-10-21'),
  ('', 'flight', 'travel', 1, '2026-10-21'),
  ('', 'airbnb', 'travel', 1, '2026-10-21'),
  ('', 'haircut', 'personal_care', 1, '2026-10-21'),
  ('', 'barber', 'personal_care', 1, '2026-10-21'),
  ('', 'salon', 'personal_care', 1, '2026-10-21'),
  ('', 'diapers', 'kids', 1, '2026-10-21'),
  ('', 'toys', 'kids', 1, '2026-10-21'),
  ('', 'gift', 'gifts', 1, '2026-10-21'),
  ('', 'present', 'gifts', 1, '2026-10-21'),
  ('', 'savings', 'investments', 1, '2026-10-21'),
  ('', 'stocks', 'investments', 1, '2026-10-21');

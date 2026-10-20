-- ExpenseAgent schema (plan section 8).
CREATE TABLE categories (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE budgets (
  category TEXT NOT NULL REFERENCES categories(key),
  month TEXT NOT NULL,            -- YYYY-MM
  amount REAL,                    -- NULL = untracked
  PRIMARY KEY (category, month)
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,            -- ULID
  amount REAL NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  category TEXT NOT NULL REFERENCES categories(key),
  expense_date TEXT NOT NULL,     -- YYYY-MM-DD, Cairo
  note TEXT NOT NULL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,           -- chat | mcp | import | api
  request_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (request_id, line_index)
);

CREATE INDEX idx_expenses_date ON expenses (expense_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_expenses_request ON expenses (request_id);

CREATE TABLE merchant_map (
  term TEXT PRIMARY KEY,
  category TEXT NOT NULL REFERENCES categories(key),
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE legacy_monthly_totals (
  month TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES categories(key),
  amount REAL NOT NULL,
  PRIMARY KEY (month, category)
);

CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  user_text TEXT,
  path TEXT,                      -- regex | llm | mcp | api
  model TEXT,
  tool_calls TEXT,                -- JSON
  results TEXT,                   -- JSON
  latency_ms INTEGER,
  error TEXT,
  response TEXT                   -- JSON; replayed on retry with the same request_id (D12)
);

CREATE INDEX idx_logs_request ON logs (request_id);

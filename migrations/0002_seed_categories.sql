-- Fixed category list (plan 8, design notes). The model only ever sees the keys.
INSERT INTO categories (key, display_name, sort_order) VALUES
  ('food_dining',     'Food & Dining',         1),
  ('groceries',       'Groceries',             2),
  ('transport_fuel',  'Transportation & Fuel', 3),
  ('bills_utilities', 'Bills & Utilities',     4),
  ('entertainment',   'Entertainment',         5),
  ('shopping',        'Shopping',              6),
  ('sports',          'Squash and sports',     7),
  ('other',           'Other',                 8);

-- Starting budgets for October 2026. NULL = untracked until you set an amount
-- (in the UI, or by chat: "set groceries to 6000"). Copy-forward fills later months.
-- Only 'Other' is known from the Excel sheet; Shopping has no budget there.
INSERT INTO budgets (category, month, amount) VALUES
  ('food_dining',     '2026-10', NULL),
  ('groceries',       '2026-10', NULL),
  ('transport_fuel',  '2026-10', NULL),
  ('bills_utilities', '2026-10', NULL),
  ('entertainment',   '2026-10', NULL),
  ('shopping',        '2026-10', NULL),
  ('sports',          '2026-10', NULL),
  ('other',           '2026-10', 12650);

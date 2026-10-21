-- Each account picks the currency its budgets and totals are in (D45).
-- Existing accounts keep EGP, which is what all their data is in.
ALTER TABLE users ADD COLUMN currency TEXT NOT NULL DEFAULT 'EGP';

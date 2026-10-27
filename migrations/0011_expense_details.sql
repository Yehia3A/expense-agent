-- Optional notes on an expense (D47): the story behind an unusual one-off,
-- e.g. "Fixing the car's wheel bearing". Shown only in the monthly report.
ALTER TABLE expenses ADD COLUMN details TEXT;

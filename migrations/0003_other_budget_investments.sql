-- D1 resolved (2026-10-20): 'Other' is what is left each month, invested in
-- Thndr index funds, gold or bitcoin. Its budget rises by 6,000 EGP
-- (12,650 -> 18,650) so the monthly total budget is 31,000 once the other
-- categories carry their usual amounts (12,350 together).
UPDATE budgets SET amount = 18650 WHERE category = 'other' AND month >= '2026-10';

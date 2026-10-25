# Security

ExpenseAgent is a public app: anyone can create an account. The job of the security layer is that **each account only ever reaches its own data**, that guessing passwords or flooding sign-ups doesn't work, and that the shared free quotas can't be drained.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately on GitHub: the repository's **Security** tab → **Report a vulnerability** ([direct link](https://github.com/Yehia3A/expense-agent/security/advisories/new)). Describe what you found and how to reproduce it. Only test against your own account or your own deployment, never other people's data.

This is a personal project with no bug bounty and no guaranteed response time (see the [Disclaimer](../README.md#disclaimer)), but reports are read and fixed as soon as possible.

## What protects what

| Layer | Protects | How |
|---|---|---|
| Per-account data | Everyone's expenses | Every row of personal data (expenses, budgets, spreadsheet totals, learned words, logs) carries its owner's id, and every query filters on the signed-in account. Tests in `test/isolation.test.ts` check that another account's data can't be listed, reported, edited, deleted, undone, replayed through chat or reached with an MCP token, even with its ids. |
| Passwords | Accounts | PBKDF2-SHA256 with a random salt (20,000 iterations, limited by the free plan's CPU; see Known limits). Only the hash is stored. Unknown usernames take as long as wrong passwords. |
| Sessions | Browsers | Random 256-bit token in an HttpOnly, Secure, SameSite=Strict cookie, valid 30 days and sliding with use. Only its SHA-256 is stored. Changing the password signs out other devices; signing out deletes the session. |
| Personal API tokens | `/api`, `/chat`, `/mcp` from scripts and MCP clients | One per account, created in the user menu and shown once. Only the SHA-256 is stored. A new token replaces the old one, and it can be revoked. Creating one needs a browser sign-in, not another token. |
| Brute-force limits | Sign-in, password checks | 10 tries per 15 minutes per IP, 300 per hour overall. |
| Sign-up limits | D1 quota, bots | 5 new accounts per IP per day, 300 per day overall. `SIGNUP_OPEN = "off"` closes sign-ups. |
| Usage limits | Groq and Cloudflare quotas | Per account: 20 chat messages a minute and 200 a day, 300 API calls a minute. All accounts together: 800 messages a day may use the LLM; the fast path doesn't count. |
| CSRF guard | Writes | Cross-origin `Origin`, `Sec-Fetch-Site: cross-site` and non-JSON bodies are refused (403). No CORS headers are ever sent. |
| Headers | UI and API | Strict CSP (`'self'` only, no inline script or style), `frame-ancestors 'none'`, `nosniff`, `no-referrer` (`public/_headers` and API responses). |
| Secrets | Groq key | Only in Cloudflare secrets / `.dev.vars` (gitignored), never sent to browsers. Logs keep message text, never keys. |
| Account deletion | Users' privacy | "Delete account" in the user menu (password required) removes the account and every row of its data. |
| Optional: Cloudflare Access | A private deployment | If you set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, every API call must also pass Cloudflare Access (a login wall at Cloudflare's edge). Don't use this for the public app: it would lock everyone else out. |

## Forgot a password?

There's no email, so there's no self-service reset. The owner, who has the Cloudflare login, can set a temporary password:

```bash
npm run reset-password:remote -- <username>
```

It prints a temporary password and signs that account out everywhere; the data stays. The person signs in with it and changes it from the user menu (Change password).

## Manual checklist (after any auth change)

Replace `$URL` with your deployed URL.

- [ ] A private browser window shows the welcome page. Sign up works with only a username and password.
- [ ] Data calls without a sign-in are refused (expect 401):
  ```bash
  curl -i "$URL/api/budget-status"
  ```
- [ ] A second account sees none of the first account's expenses.
- [ ] Cross-site write is refused (expect 403):
  ```bash
  curl -i -X POST -H "content-type: application/json" -H "origin: https://evil.example" -d '{"username":"x1234","password":"long enough pass"}' "$URL/api/auth/signup"
  ```
- [ ] Wrong passwords: the 11th try within 15 minutes gets "Too many sign-in attempts".
- [ ] `npx wrangler secret list` shows only the name `LLM_API_KEY`, and `git grep -n "gsk_\|sk-or-"` finds nothing.
- [ ] Response headers on `$URL/` include `content-security-policy` and `x-frame-options: DENY`.
- [ ] Your Cloudflare account has two-factor authentication on (dash.cloudflare.com → My Profile → Authentication). Whoever controls it controls the database.

## Known limits

- **Password hashing is lighter than ideal** (20,000 PBKDF2 rounds instead of 600,000) because the free plan allows 10 ms of CPU per request. Over the internet, guessing is stopped by the rate limits. The lighter hashing only matters if someone copied the database, which takes your Cloudflare account: protect it with two-factor authentication. On a paid plan, raise `DEFAULT_ITERATIONS` in `src/security/passwords.ts`; old hashes keep working.
- **Shared quotas can be used up.** A burst of new users, or someone creating many accounts from many networks, can use up the day's LLM quota (simple messages keep working), the sign-up allowance or Cloudflare's free daily requests. Nothing is billed; the app recovers the next day. If it happens a lot, close sign-ups (`SIGNUP_OPEN = "off"`) or add a CAPTCHA (Cloudflare Turnstile is free).
- **No email**, so no password-reset emails; see "Forgot a password?".
- **Privacy:** people's spending notes are stored in your Cloudflare D1 database and sent to Groq when the AI handles a message. Voice clips go to Groq for transcription and are not stored; only the resulting text is logged. The microphone is only used while the mic button is active, and only on this site (`Permissions-Policy: microphone=(self)`). If you invite others, tell them so. Each account can delete everything it stored.

# Security (Phase 3)

## What protects what

| Layer | Protects | How |
|---|---|---|
| Cloudflare Access | Everything: UI, `/api`, `/chat` | Login wall at Cloudflare's edge. Only your email gets in. |
| Access JWT check in the Worker | `/api`, `/chat` | Every request must carry a valid Access JWT (signature, issuer, audience, expiry). The raw `workers.dev` URL and any route Access doesn't cover are refused. `src/security/access.ts` |
| `APP_TOKEN` (optional) | `/api`, `/chat` | `Authorization: Bearer` for scripts, or as a fallback without Access. Compared in constant time. |
| Fail-closed default | `/api`, `/chat` | With neither Access nor `APP_TOKEN` configured, only `localhost` is served. A deployed Worker answers 503 instead of running open. |
| Rate limits | LLM quota, D1 | Global fixed windows in D1: `/chat` 20/min and 500/day, whole API 300/min (vars in `wrangler.jsonc`). 429 with `Retry-After`. |
| CSRF guard | Writes | Cross-origin `Origin`, `Sec-Fetch-Site: cross-site` and non-JSON bodies are refused (403). No CORS headers are ever sent. |
| Headers | UI and API | Strict CSP (`'self'` only, no inline script or style), `frame-ancestors 'none'`, `nosniff`, `no-referrer` (`public/_headers` and API responses). |
| Secrets | API keys | Only in Worker secrets / `.dev.vars` (gitignored). Logs store your message text, never keys. |

## Set up Cloudflare Access (once, about 10 minutes)

1. Deploy once (see README). Note the URL, e.g. `expense-agent.<you>.workers.dev`.
2. Cloudflare dashboard → **Zero Trust** (free plan for up to 50 users). Pick a team name; your team domain is `<team>.cloudflareaccess.com`.
3. **Access → Applications → Add an application → Self-hosted.** Domain: your workers.dev hostname (or custom domain). Session duration: 1 month is fine for a personal app.
   - Shortcut: Workers & Pages → your Worker → Settings → Domains & Routes → workers.dev → **Enable Cloudflare Access** creates this application for you.
4. Policy: **Allow**, Include → Emails → your email. Login method: One-time PIN (default) or Google.
5. Copy the application's **Audience (AUD) tag** (Application → Overview / Additional settings).
6. Put both values in `wrangler.jsonc` → `vars`:
   ```jsonc
   "ACCESS_TEAM_DOMAIN": "<team>.cloudflareaccess.com",
   "ACCESS_AUD": "<aud tag>"
   ```
7. `npm run deploy`.

Keep `APP_TOKEN` set as well if you want to call the API from scripts or a future MCP client; otherwise it can be removed with `npx wrangler secret delete APP_TOKEN`.

## Manual checklist (run after every auth change)

Replace `$URL` with your deployed URL.

- [ ] Private browser window → `$URL` → Access login page appears; after login the app loads.
- [ ] Unauthenticated API call is refused (expect 401, or 302 to the Access login if Access sits in front):
  ```bash
  curl -i "$URL/api/health"
  ```
- [ ] Forged Access header is refused (expect 401):
  ```bash
  curl -i -H "cf-access-jwt-assertion: a.b.c" "$URL/api/health"
  ```
- [ ] If you use a custom domain, the raw `workers.dev` URL is also refused (or disable it: `"workers_dev": false` in `wrangler.jsonc`).
- [ ] Cross-site write is refused (expect 403):
  ```bash
  curl -i -X PUT -H "content-type: application/json" -H "origin: https://evil.example" -H "authorization: Bearer $APP_TOKEN" -d '{"category":"groceries","amount":1}' "$URL/api/budgets"
  ```
- [ ] Rate limit trips: send 21 chat messages within a minute; the 21st gets "rate limit reached".
- [ ] `npx wrangler secret list` shows only names (`LLM_API_KEY`, `APP_TOKEN`), and `git grep -n "gsk_\|sk-or-"` finds nothing.
- [ ] Response headers on `$URL/` include `content-security-policy` and `x-frame-options: DENY`.

## Known limits

- Rate limits are global, not per user, because there is one user. Abuse from a stolen session still hits the same caps, which protects the LLM quota.
- The static UI is public if Access is not set up; it contains no data, and every data call is authenticated.
- `/mcp` (Phase 6) will need its own auth (Access service token or `APP_TOKEN`).

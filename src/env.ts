export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  TIMEZONE?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  LARGE_AMOUNT_THRESHOLD?: string;
  OLD_DATE_CONFIRM_DAYS?: string;
  // Cloudflare Access (Phase 3). Both must be set to enable JWT checks.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // Rate limits (Phase 3). 0 disables a limit.
  CHAT_RATE_PER_MIN?: string;
  CHAT_RATE_PER_DAY?: string;
  API_RATE_PER_MIN?: string;
  // Secrets
  LLM_API_KEY?: string;
  APP_TOKEN?: string;
}

export interface AppConfig {
  tz: string;
  largeAmountThreshold: number;
  oldDateConfirmDays: number;
}

export function appConfig(env: Env): AppConfig {
  return {
    tz: env.TIMEZONE || "Africa/Cairo",
    largeAmountThreshold: num(env.LARGE_AMOUNT_THRESHOLD, 5000),
    oldDateConfirmDays: num(env.OLD_DATE_CONFIRM_DAYS, 60),
  };
}

export function rateLimits(env: Env) {
  return {
    chatPerMin: num(env.CHAT_RATE_PER_MIN, 20),
    chatPerDay: num(env.CHAT_RATE_PER_DAY, 500),
    apiPerMin: num(env.API_RATE_PER_MIN, 300),
  };
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
}

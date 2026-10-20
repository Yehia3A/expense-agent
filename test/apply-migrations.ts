import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: applies only migrations not yet recorded in d1_migrations.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Eval runner (Phase 5): real LLM calls, so it is separate from `npm test`.
// Start it through `node scripts/eval.mjs`, which sets these variables.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const pass = (k: string) => (process.env[k] ? { [k]: process.env[k]! } : {});
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...pass("LLM_PROVIDER"),
            ...pass("LLM_MODEL"),
            ...pass("LLM_BASE_URL"),
            ...pass("LLM_API_KEY"),
            ...pass("EVAL_MODE"),
            ...pass("EVAL_DELAY_MS"),
            ...pass("EVAL_CASES"),
            ...pass("EVAL_LIMIT"),
          },
        },
      }),
    ],
    test: {
      include: ["eval/**/*.eval.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 120_000,
      maxConcurrency: 1,
      fileParallelism: false,
    },
  };
});

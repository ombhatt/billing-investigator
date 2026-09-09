import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// TEST_MIGRATIONS is injected by vitest.config.ts and exists only under test,
// so it is typed here rather than augmenting the app's Env globally.
const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

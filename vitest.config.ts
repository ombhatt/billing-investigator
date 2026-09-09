import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations
} from "@cloudflare/vitest-pool-workers";

// Migrations are read at config time and applied per test worker in setup,
// so tests run against the same schema the app does.
const migrations = await readD1Migrations(
  path.join(import.meta.dirname, "migrations")
);

export default defineConfig({
  test: {
    projects: [
      {
        // Domain calculations import no Cloudflare binding, so they run in
        // plain Node. Keeping them out of the Workers pool makes them fast and
        // proves the domain layer really is runtime-independent.
        test: {
          name: "unit",
          include: ["test/unit/**/*.spec.ts"],
          environment: "node"
        }
      },
      {
        plugins: [
          cloudflareTest({
            // The app's Workers AI binding is `remote: true`. Left enabled, the
            // pool opens an authenticated remote proxy session and tests would
            // require a Cloudflare login plus network access. Tool tests need
            // D1 only.
            remoteBindings: false,
            miniflare: {
              compatibilityDate: "2026-06-11",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: ["DB"],
              bindings: { TEST_MIGRATIONS: migrations }
            }
          })
        ],
        test: {
          name: "integration",
          include: ["test/integration/**/*.spec.ts"],
          setupFiles: ["./test/setup.ts"]
        }
      }
    ]
  }
});

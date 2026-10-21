import { defineConfig, type ViteUserConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

const config: ViteUserConfig = defineConfig({
  define: { __CLICKSTACK_VERSION__: JSON.stringify(pkg.version) },
  test: {
    unstubEnvs: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text"],
      thresholds: { lines: 90, branches: 90 },
    },
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["e2e/**/*.test.ts"],
          // Child processes of the built package against a collector in Docker.
          globalSetup: "e2e/global-setup.ts",
          testTimeout: 60_000,
        },
      },
    ],
  },
});

export default config;

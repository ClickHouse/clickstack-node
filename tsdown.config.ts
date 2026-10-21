import { defineConfig, type UserConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

const config: UserConfig = defineConfig({
  entry: ["src/index.ts", "src/register.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  // No `target`: tsdown derives it from engines.node, so the floor lives in one place. The CJS
  // build is deliberate: TypeScript CJS consumers on `module: node16` cannot type an ESM-only build.
  checks: { legacyCjs: false },
  fixedExtension: true,
  // Unbundled and not minified, so stack traces are readable without source maps.
  unbundle: true,
  dts: true,
  clean: true,
  failOnWarn: true,
  define: { __CLICKSTACK_VERSION__: JSON.stringify(pkg.version) },
});

export default config;

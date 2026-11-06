import { defineConfig, type UserConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

// The files that call `require`, which eslint.config.js allows in these files only.
const usesRequire = new Set(["hook.mjs", "sdk.mjs"]);

const config: UserConfig = defineConfig({
  entry: ["src/index.ts", "src/register.ts"],
  // `require` calls stay literal in both builds, so file tracers (@vercel/nft, used by Next.js
  // standalone output and Vercel) copy what init() loads lazily. Rolldown's own `require` for the
  // ESM build is an imported function, which tracers do not follow.
  format: {
    esm: {
      outputOptions: { polyfillRequire: false },
      banner: ({ fileName }) =>
        usesRequire.has(fileName)
          ? {
              js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
            }
          : undefined,
    },
    cjs: {},
  },
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

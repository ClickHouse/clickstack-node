// A namespace import, because `registerHooks` arrived in Node 22.15 and 23.5: a named import of a
// missing builtin export fails to link the ES module build on 23.0 to 23.4, before init() runs.
import * as nodeModule from "node:module";
import type { ResolveHookSync } from "node:module";
import { pathToFileURL } from "node:url";
import type { EsmHookMode } from "./state.ts";

/** The part of `import-in-the-middle/register-hooks.mjs` used here; its typings do not load. */
interface SyncHooks {
  supportsSyncHooks: () => boolean;
  register: () => void;
}

/*
 * import-in-the-middle 3.5 treats a resolution without a parent URL as the entry point and forces
 * `format: 'commonjs'` on any URL without a script extension. `require('node:os')` from the REPL
 * (and from `node -e` or `-p` on some Node versions) is then read from a file named `os`, and an
 * ES module bin script without a file extension crashes. Registered after import-in-the-middle, so
 * this runs first and repairs its result.
 */
const restoreFormat: ResolveHookSync = (specifier, context, nextResolve) => {
  const isEntry = context.parentURL === undefined;
  const result = nextResolve(specifier, context);

  if (result.format !== "commonjs") return result;
  if (result.url.startsWith("node:")) return { ...result, format: "builtin" };

  return isEntry &&
    result.url.startsWith("file:") &&
    !/\.[cm]?[jt]s$/.test(result.url)
    ? { ...result, format: undefined }
    : result;
};

/**
 * Installs the import-in-the-middle ESM loader hook in this thread.
 *
 * import-in-the-middle is loaded from `@opentelemetry/instrumentation`'s own location: only the
 * copy next to it sees the `Hook()` calls instrumentations make. The package's own dependency on
 * it is never imported; it raises that copy to the 3.5 line, whose behavior the repair above
 * expects (`@opentelemetry/instrumentation` accepts any 3.x). Synchronous hooks
 * (`module.registerHooks`) are used where import-in-the-middle supports them; `module.register`,
 * which Node 26 deprecates (DEP0205), is the fallback for older Node versions and for runtimes
 * that disable `require(esm)` (AWS Lambda).
 *
 * @returns `'sync'` for `module.registerHooks`, `'async'` for `module.register`.
 * @throws If `@opentelemetry/instrumentation/hook.mjs` cannot be resolved or Node rejects the hook.
 */
export function installEsmHook(): EsmHookMode {
  // `package.json` is not exported, so the hook file itself is resolved.
  const hookFile = nodeModule
    .createRequire(import.meta.url)
    .resolve("@opentelemetry/instrumentation/hook.mjs");

  let syncHooks: SyncHooks | undefined;
  try {
    syncHooks = nodeModule.createRequire(hookFile)(
      "import-in-the-middle/register-hooks.mjs",
    ) as SyncHooks;
  } catch {
    // Old import-in-the-middle, or require(esm) disabled: the asynchronous loader covers both.
  }

  if (syncHooks?.supportsSyncHooks() === true) {
    syncHooks.register();
    nodeModule.registerHooks({ resolve: restoreFormat });
    return "sync";
  }

  nodeModule.register(pathToFileURL(hookFile));

  return "async";
}

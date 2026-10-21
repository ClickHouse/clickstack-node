/**
 * Zero-code entry: starts the SDK from environment variables only, as `init()` without options.
 * Worker threads are skipped; call `init()` inside a worker to instrument it.
 *
 * @example
 * ```sh
 * NODE_OPTIONS="--import @clickhouse/clickstack-node/register" node app.mjs
 * ```
 */
import { isMainThread } from "node:worker_threads";
import { init } from "./init.ts";

if (isMainThread) init();

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@clickhouse/clickstack-node");
    init();

    // Next.js loads node:http before register(), so only a later load patches it. Like an ES
    // module dependency of an app, this import goes through the loader hook.
    await import(/* webpackIgnore: true */ "node:http");
  }
}

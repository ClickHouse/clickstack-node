export default {
  output: "standalone",
  // The test builds a copy in a temporary directory; trace from there.
  outputFileTracingRoot: import.meta.dirname,
  serverExternalPackages: ["@clickhouse/clickstack-node"],
};

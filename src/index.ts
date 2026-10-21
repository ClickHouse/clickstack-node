/**
 * ClickStack distribution of the OpenTelemetry Node.js SDK: one call or one `--import` flag sends
 * traces, metrics and logs to ClickStack over OTLP, using upstream OpenTelemetry packages and the
 * standard `OTEL_*` environment variables.
 *
 * @packageDocumentation
 */
export type { ClickStackNodeOptions } from "./config.ts";
export { init } from "./init.ts";
export { flush, shutdown, withFlush } from "./lifecycle.ts";

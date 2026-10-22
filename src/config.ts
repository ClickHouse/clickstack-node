import type { InstrumentationConfigMap } from "@opentelemetry/auto-instrumentations-node";
import { getStringFromEnv } from "@opentelemetry/core";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { setDefault, warnOnce } from "./env.ts";

const HEADERS = "OTEL_EXPORTER_OTLP_HEADERS";

/**
 * Options for `init`. Options with an environment variable are written to `process.env` only
 * when that variable is unset, so an operator's setting always wins and child processes inherit
 * the value. Every other setting comes from the standard `OTEL_*` variables.
 *
 * @public
 */
export interface ClickStackNodeOptions {
  /**
   * The `service.name` resource attribute. Written to `OTEL_SERVICE_NAME`, unless
   * `OTEL_RESOURCE_ATTRIBUTES` sets `service.name`.
   *
   * @defaultValue upstream: `unknown_service:` followed by the Node.js executable name
   */
  serviceName?: string | undefined;
  /**
   * Base URL of the OTLP/HTTP receiver, without `/v1/traces`. Written to
   * `OTEL_EXPORTER_OTLP_ENDPOINT`.
   *
   * @defaultValue upstream: `http://localhost:4318`
   */
  endpoint?: string | undefined;
  /**
   * `deployment.environment.name`, such as `production` or `staging`. Set on the resource, not
   * written to the environment. A value for the same key in `OTEL_RESOURCE_ATTRIBUTES` wins.
   *
   * @defaultValue none
   */
  environment?: string | undefined;
  /**
   * ClickStack ingestion key, sent as the `authorization` header. Trimmed, percent-encoded and
   * written to `OTEL_EXPORTER_OTLP_HEADERS` as `authorization=<key>`. Ignored with one warning
   * when that variable already holds something else.
   *
   * @defaultValue none
   */
  apiKey?: string | undefined;
  /**
   * Records HTTP request and response bodies on `node:http` spans, and on `fetch` spans from
   * Node.js 24.4. Bodies can contain personal data and add storage cost. Written to
   * `CLICKSTACK_CAPTURE_HTTP_BODY`.
   *
   * @defaultValue `false`
   */
  httpBodyCapture?: boolean | undefined;
  /**
   * Configuration for the auto-instrumentations bundle, in the shape of
   * `getNodeAutoInstrumentations()`. Hooks given here run after this package's hooks.
   *
   * @defaultValue `{}`
   */
  instrumentations?: InstrumentationConfigMap | undefined;
  /**
   * Instrumentation instances to add to the bundle's, for libraries the bundle does not cover.
   *
   * @defaultValue `[]`
   */
  additionalInstrumentations?: Instrumentation[] | undefined;
}

/**
 * Writes the options that have an environment variable to `process.env` where it is unset.
 *
 * @param options - The `init` options.
 */
export function applyOptions(options: ClickStackNodeOptions): void {
  // OTEL_SERVICE_NAME outranks service.name in OTEL_RESOURCE_ATTRIBUTES, so writing it would
  // override an operator's value there.
  const attributes = getStringFromEnv("OTEL_RESOURCE_ATTRIBUTES") ?? "";
  if (
    !attributes
      .split(",")
      .some((a) => a.split("=")[0]?.trim() === "service.name")
  ) {
    setDefault("OTEL_SERVICE_NAME", options.serviceName);
  }

  setDefault("OTEL_EXPORTER_OTLP_ENDPOINT", options.endpoint);

  if (options.httpBodyCapture !== undefined) {
    setDefault("CLICKSTACK_CAPTURE_HTTP_BODY", String(options.httpBodyCapture));
  }

  const apiKey = options.apiKey?.trim();
  if (!apiKey) return;

  // Header values are percent-decoded upstream, and ',' and ';' would split them.
  const header = `authorization=${encodeURIComponent(apiKey)}`;
  const current = getStringFromEnv(HEADERS);
  // A forked child inherits the value its parent's init() wrote; that is not a conflict.
  if (current !== undefined && current !== header) {
    warnOnce("api-key", `${HEADERS} is set, so the apiKey option is ignored`);
  }
  setDefault(HEADERS, header);

  const endpoints = ["", "_TRACES", "_METRICS", "_LOGS"];
  if (
    endpoints.every(
      (s) => getStringFromEnv(`OTEL_EXPORTER_OTLP${s}_ENDPOINT`) === undefined,
    )
  ) {
    warnOnce(
      "no-endpoint",
      "apiKey is set but OTEL_EXPORTER_OTLP_ENDPOINT is not",
    );
  }
}

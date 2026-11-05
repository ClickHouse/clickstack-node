# Changelog

## 1.0.2

### Fixed

- Next.js `output: "standalone"`, and other builds that copy only the files their tracer finds, now
  include the ES module loader hook. Webpack builds left it out, so the server started with a
  warning and, in many apps, without HTTP spans. Turbopack builds left out its synchronous hooks
  and fell back to `module.register()`.
- Those builds now also include the OpenTelemetry packages that `init` loads when the app uses the
  CommonJS build. Since 1.0.1 they were left out, so `init` could not start the SDK.

### Documentation

- README: a Next.js section (setup, the two server spans of a request, ignoring requests for static
  files, "ended Span" warnings, flushing on SIGTERM with `NEXT_MANUAL_SIG_HANDLE=true`, and
  import-in-the-middle warnings), errors in Express `use()` calls with several handlers, and FATAL
  records for exceptions that an app `uncaughtException` listener survives.
- Migration guide: for logs sent to a second endpoint, the other headers of
  `OTEL_EXPORTER_OTLP_HEADERS` and `NaN` attribute values; alerts on FATAL records for exceptions
  the app survives.

## 1.0.1

### Fixed

- Importing the package no longer loads the OpenTelemetry SDK; `init` loads it when it starts the
  SDK. Apps that only import `flush` or `shutdown`, or set `OTEL_SDK_DISABLED=true`, no longer
  spend about 300 ms loading it.
- A boolean variable set to something other than `true` or `false`, such as `OTEL_SDK_DISABLED=1`,
  now logs the upstream warning instead of being ignored silently.

### Documentation

- README: setting attributes on a request's server span, guarding a preload file against worker
  threads, `--require` with ts-node, an `uncaughtException` listener that flushes, errors passed
  to `next(err)`, and installing `@opentelemetry/api@~1.9.1` when the app imports it.
- Migration guide: the old preload's no-key gate, sending some logs to a second endpoint, the
  versions of `@opentelemetry/winston-transport` and the baggage processors for OpenTelemetry JS
  2.x, renamed host metrics, and errors recorded twice through `recordException`.

## 1.0.0

First release of `@clickhouse/clickstack-node`, the ClickStack distribution of the upstream
OpenTelemetry Node.js SDK. It replaces `@hyperdx/node-opentelemetry`; see the
[migration guide](docs/migration.md).

- One flag (`--import` or `--require` of `@clickhouse/clickstack-node/register`) or one `init`
  call starts the SDK with the upstream auto-instrumentations bundle, `console` capture and crash
  capture, for CommonJS and ES module apps.
- Telemetry is flushed on exit, on SIGTERM and SIGINT (also as PID 1) and after an uncaught
  exception, whose record carries the `cause` chain. `flush`, `shutdown` and `withFlush` for AWS
  Lambda.
- Opt-in capture of HTTP headers, from the standard environment variables, and of request and
  response bodies, with redaction.
- Options `serviceName`, `endpoint`, `environment`, `apiKey`, `httpBodyCapture`,
  `instrumentations` and `additionalInstrumentations`. Environment variables always win.
- The 1.x line supports OpenTelemetry JS 2.x: `@opentelemetry/api` 1.9, on Node.js 22.15 or later.

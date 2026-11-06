# @clickhouse/clickstack-node

Traces, metrics and logs from Node.js apps to ClickStack, built on the upstream OpenTelemetry
Node.js SDK. One flag or one `init` call starts the SDK with the upstream auto-instrumentations,
records `console` output and crashes, and flushes telemetry on exit, termination signals and AWS
Lambda invocations. Exporters, batching, sampling and every `OTEL_*` variable stay upstream. Apps
that set up the SDK themselves do not need this package
([Using the upstream SDK directly](#using-the-upstream-sdk-directly)).

If you're migrating from `@hyperdx/node-opentelemetry` please follow the
[migration guide](docs/migration.md).

## Install

```sh
npm install @clickhouse/clickstack-node
```

The package needs Node.js 22.15 or later and ships ES module and CommonJS builds.
`@opentelemetry/api` is a peer dependency, which npm installs automatically, so the app and the
SDK share one copy. If the app imports it too, install `@opentelemetry/api@~1.9.1`: npm's latest
1.10 is for OpenTelemetry JS 3.x and outside this package's range.

## Quick start

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://example-collector.clickhouse.com:4318
export OTEL_EXPORTER_OTLP_HEADERS="authorization=<YOUR_INGESTION_API_KEY>"
export OTEL_SERVICE_NAME=example-app
node --import @clickhouse/clickstack-node/register server.js
```

The endpoint is the OTLP HTTP address of your OpenTelemetry collector (port 4318), without
`/v1/traces`. With ClickStack, it is your service's collector URL.

The flag works for CommonJS and ES module apps, and `--require` works too. In `NODE_OPTIONS`, set
it only on the command that runs the app, because build tools and every other Node.js process
inherit it.

Or call `init` in code, at the top of a CommonJS entry file before anything else is required:

```js
const { init } = require("@clickhouse/clickstack-node");

init({
  endpoint: "https://example-collector.clickhouse.com:4318",
  apiKey: "<YOUR_INGESTION_API_KEY>",
  serviceName: "example-app",
});
```

Static imports run before any code in an ES module, so an ES module app calls `init` in a file of
its own and preloads it: `node --import ./instrumentation.mjs server.mjs`. A preload file also runs
in every worker thread, such as the workers of pino transports, and each `init` there starts an
SDK. Guard the call with `isMainThread` from `node:worker_threads`, as the register entry does.

| Option                       | Environment variable (wins)                                          | Default                                    | Meaning                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`                   | `OTEL_EXPORTER_OTLP_ENDPOINT`                                        | `http://localhost:4318`                    | OTLP/HTTP base URL of the collector. `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended.                                                                 |
| `serviceName`                | `OTEL_SERVICE_NAME`, or `service.name` in `OTEL_RESOURCE_ATTRIBUTES` | `unknown_service:` and the executable name | `service.name` of all telemetry.                                                                                                                              |
| `environment`                | `OTEL_RESOURCE_ATTRIBUTES` (`deployment.environment.name=<env>`)     | None                                       | `deployment.environment.name`, such as `production` or `staging`.                                                                                             |
| `apiKey`                     | `OTEL_EXPORTER_OTLP_HEADERS` (`authorization=<key>`)                 | None                                       | Ingestion key, sent as the `authorization` header. Send the bare key; `Bearer <key>` works only on ClickStack 2.38.0 or later.                                |
| `httpBodyCapture`            | `CLICKSTACK_CAPTURE_HTTP_BODY`                                       | `false`                                    | Records request and response bodies ([Privacy](#privacy)).                                                                                                    |
| `instrumentations`           | None                                                                 | Upstream defaults                          | The `getNodeAutoInstrumentations()` config map. An `enabled` value here beats `OTEL_NODE_ENABLED_INSTRUMENTATIONS` and `OTEL_NODE_DISABLED_INSTRUMENTATIONS`. |
| `additionalInstrumentations` | None                                                                 | `[]`                                       | Instrumentation instances to add to the bundle's, for libraries the bundle does not cover.                                                                    |

`init` writes `serviceName`, `endpoint`, `apiKey` and `httpBodyCapture` to their variables only
when those are unset or blank, so an operator's value wins and child processes inherit it;
`environment` goes on the resource only. When `OTEL_EXPORTER_OTLP_HEADERS` already holds other
headers, `apiKey` is ignored with a warning. Use either the flag or `init`: a second
start logs a warning and does nothing. The rest is fixed:

- Instrumentations: the upstream auto-instrumentations bundle with its defaults, plus `console`
  capture (`@opentelemetry/instrumentation-console`) and crash capture. To turn `console` capture
  off, add `console` to `OTEL_NODE_DISABLED_INSTRUMENTATIONS`. It is also off while
  `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` or `OTEL_LOGS_EXPORTER` includes `console`,
  because those exporters print with `console`.
- The router instrumentation is off. Express 5 is built on the `router` package, so with it every
  Express middleware gets a second span and every route error three exception events. To turn it
  on, list `router` in `OTEL_NODE_ENABLED_INSTRUMENTATIONS`, or set `enabled: true` for
  `@opentelemetry/instrumentation-router` in `instrumentations`.
- Resource detectors: `container,host,os,process,serviceinstance,env`, so nothing probes cloud
  metadata endpoints at startup. To add a cloud detector, set `OTEL_NODE_RESOURCE_DETECTORS` to the
  whole list, without spaces and with `env` last, for example
  `container,host,os,process,serviceinstance,aws,env`.
- Diagnostics go to stderr at WARN level (`OTEL_LOG_LEVEL`), unless the app registered its own
  `diag` logger first. They include unknown names in `OTEL_NODE_ENABLED_INSTRUMENTATIONS`,
  `OTEL_NODE_DISABLED_INSTRUMENTATIONS` and `OTEL_NODE_RESOURCE_DETECTORS`. Messages from this
  package start with `clickstack-node:`.
- Every other OpenTelemetry variable keeps its upstream meaning, for example
  `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf`; `grpc` goes to port 4317),
  `OTEL_TRACES_SAMPLER`, `OTEL_PROPAGATORS` and `OTEL_METRIC_EXPORT_INTERVAL`. Boolean variables
  are true only for `true`. `OTEL_SDK_DISABLED=true` makes the flag and `init` do nothing.

Other functions:

- `flush(timeoutMillis)` exports what is buffered. It waits at most 5000 ms by default and never
  rejects.
- `shutdown(timeoutMillis)` flushes and stops the SDK, with the same bound. Await it before your
  own code exits the process ([Lifecycle](#lifecycle)).
- `withFlush(handler)` wraps an async AWS Lambda handler, so telemetry is exported before each
  invocation returns.

## Privacy

`console` output and crash stack traces are exported by default. Headers and bodies are recorded
only when you turn them on; they can hold personal data and credentials.

- Headers: `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_{SERVER,CLIENT}_{REQUEST,RESPONSE}` each list
  exact header names, comma-separated, such as `user-agent,x-request-id`. They are recorded as
  `http.request.header.<name>` and `http.response.header.<name>`. Names on
  `OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SANITIZE_FIELDS` (by default
  `authorization,cookie,set-cookie,proxy-authorization,x-api-key`) are never recorded.
- Bodies: `httpBodyCapture` records `node:http` server and client bodies and `fetch` bodies (on
  Node.js 24.4 or later). Only textual UTF-8 bodies without a `Content-Encoding` are recorded, from
  the first 8192 bytes of each body; others get a size only. Values of keys that contain
  `password`, `passwd`, `secret`, `token`, `api_key`, `apikey`, `api-key`, `authorization`,
  `cookie` or `session` become `[REDACTED]` in JSON-looking text (also one level of JSON escaped
  inside a string) and in form fields. This is a best effort, so keep a redaction step in your
  collector.
- The app's streams are never read, paused or resumed, and the bytes it sends and receives are
  unchanged.

## Using the upstream SDK directly

This file sets up the upstream SDK with the same instrumentations and defaults. Start the app with
`node --require ./telemetry.cjs app.js` and the variables from the quick start, plus
`OTEL_NODE_RESOURCE_DETECTORS=container,host,os,process,serviceinstance,env`.

```js
// telemetry.cjs
const {
  getNodeAutoInstrumentations,
  getResourceDetectors,
} = require("@opentelemetry/auto-instrumentations-node");
const {
  ConsoleInstrumentation,
} = require("@opentelemetry/instrumentation-console");
const { NodeSDK } = require("@opentelemetry/sdk-node");

// Without a log level, NodeSDK prints nothing, not even export errors.
process.env.OTEL_LOG_LEVEL ??= "warn";

const sdk = new NodeSDK({
  // Reads OTEL_NODE_RESOURCE_DETECTORS; the default list includes the cloud detectors.
  resourceDetectors: getResourceDetectors(),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-runtime-node": {
        captureUncaughtException: true,
      },
      // Express 5 is already covered by the express instrumentation.
      "@opentelemetry/instrumentation-router": { enabled: false },
    }),
    new ConsoleInstrumentation(),
  ],
});
sdk.start();

process.once("SIGTERM", () => {
  sdk.shutdown().finally(() => process.kill(process.pid, "SIGTERM"));
});
```

What the package adds to this:

- ES modules: upstream registers no ES module loader hook on the 2.x line. Add
  `--experimental-loader=@opentelemetry/instrumentation/hook.mjs`, which prints an
  `ExperimentalWarning` on every start.
- Crashes: the record of an uncaught exception is exported before Node.js exits, and the process
  still exits with code 1. Upstream drops it.
- Signals: SIGINT as well as SIGTERM, a bounded shutdown, and the exit status when the app runs as
  PID 1, where a re-raised signal is ignored.
- AWS Lambda: `withFlush`, and the flush after each invocation by
  `@opentelemetry/instrumentation-aws-lambda`, which `NodeSDK` leaves bound to a no-op provider. It
  now also flushes logs, and ends before the invocation's deadline.
- Header capture from the variables above, and body capture. Upstream reads no header variables
  and has no body option.

## What is emitted

- Resource: `service.name`, `deployment.environment.name` when set, `telemetry.sdk.*`,
  `telemetry.distro.name` (`clickstack-node`), `telemetry.distro.version`, and the detector
  attributes (`host.*`, `os.*`, `process.*`, `container.id`, `service.instance.id`).
- Spans, metrics and log records from the upstream instrumentations, unchanged.
- `console` log records: the formatted message as the body, a severity number per method (`debug`
  5, `log` and `info` 9, `warn` 13, `error` 17) and the active trace context.
- A FATAL log record (severity number 21, body `exception`) with `exception.type`,
  `exception.message` and `exception.stacktrace` for an uncaught exception
  ([Errors](#errors)).
- With capture on: `http.request.header.<name>` and `http.response.header.<name>` (string arrays),
  `http.request.body.content` and `http.response.body.content`, and `http.request.body.size` and
  `http.response.body.size` (bytes). The body keys are in development in the semantic conventions.

## Attributes on a request

To find a request by user or tenant, set the attributes on its server span. The framework
instrumentations make each middleware and handler span the active span, so
`trace.getActiveSpan()` in middleware returns that short span, not the request's:

```js
import { context } from "@opentelemetry/api";
import { getRPCMetadata } from "@opentelemetry/core"; // @opentelemetry/core@^2.12.0

app.use((req, res, next) => {
  getRPCMetadata(context.active())?.span?.setAttributes({
    "user.id": req.user.id,
  });
  next();
});
```

Child spans and log records do not get these attributes. Tagging every span and log record of a
request takes span and log record processors, which need plain `NodeSDK`
([migration guide](docs/migration.md#trace-attributes)).

## Errors

- Uncaught exceptions, and unhandled rejections under Node's default
  `--unhandled-rejections=throw`, become the FATAL log record, exported before the process exits
  ([Lifecycle](#lifecycle)). It carries the active trace when the error comes from an asynchronous
  callback, such as a timer or a rejected promise. A request still open at the crash exports no
  span.
- `exception.stacktrace` is the raw stack, with the error's `cause` chain, up to five deep,
  appended as `Caused by: Name: message` sections. A thrown value that is not an error, such as
  `throw { code: 1 }`, is recorded as JSON text in `exception.message`; Node.js itself wraps a
  rejection reason that is not an error in an `ERR_UNHANDLED_REJECTION` error.
- Start TypeScript and bundled apps with `--enable-source-maps`, for example in `NODE_OPTIONS`, so
  that stack traces point to your sources when the error happens. ClickStack maps only browser
  stack traces.
- An app `uncaughtException` listener takes over the exit: the FATAL record is still recorded, also
  when the app keeps running, but the package neither prints the error nor exits, so flush before
  your listener ends the process:

  ```js
  import { flush } from "@clickhouse/clickstack-node";

  process.on("uncaughtException", (err) => {
    console.error(err);
    void flush().finally(() => process.exit(1));
  });
  ```

  An app `unhandledRejection` listener turns crash capture off for rejections, because Node.js then
  no longer treats them as crashes.

- Errors thrown in route handlers of instrumented frameworks, such as Express, Koa, Hapi and
  NestJS, or passed to `next(err)`, are recorded as `exception` events on the handler's span.
  Recording them again yourself records each one twice. Express instruments only the last handler
  of a `use()` call with several, such as `router.use("/api", auth, apiRouter)`, so an error that
  `auth` passes to `next(err)` is not recorded; a 5xx response still marks the server span as an
  error.
- Errors that your code catches are not recorded. Record them on the active span:

  ```js
  import { SpanStatusCode, trace } from "@opentelemetry/api";

  const span = trace.getActiveSpan();
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR });
  ```

- `console.error(err)` sends a log record whose body is the formatted error with its stack trace.
  It has no `exception.*` attributes, so it does not count as an exception.
- Telemetry still buffered when the app calls `process.exit()` is lost unless the app awaits
  `shutdown()` first.

## Lifecycle

- SIGTERM and SIGINT: the SDK shuts down (at most 5 seconds) and the signal is raised again, so the
  process exits with 143 or 130. If the app has its own listener for the signal, the SDK only
  flushes and the app owns the exit; await `shutdown()` in that listener before it exits.
- Uncaught exceptions, and unhandled rejections under the default `--unhandled-rejections=throw`:
  the error goes to stderr as Node.js prints it, the SDK shuts down, and the process exits with
  code 1, after 2 seconds when `@sentry/node` is installed so that Sentry can send its event. An app
  `uncaughtException` listener takes over the exit ([Errors](#errors)).
- When the event loop empties, the SDK shuts down. `process.exit()` skips this, so scripts call
  `await shutdown()` first.
- When the collector cannot be reached, these shutdowns wait the full 5 seconds. A second Ctrl-C,
  more than a second after the first, exits at once. Set `OTEL_SDK_DISABLED=true` where no
  collector runs.
- In Docker, use the exec form of `CMD` (a JSON array), or `docker run --init`. In the shell form,
  `/bin/sh` is PID 1 and does not forward signals, so `docker stop` kills the app after 10 seconds
  without a flush.
- On AWS Lambda, set `NODE_OPTIONS=--import @clickhouse/clickstack-node/register` and wrap the
  handler. Only async handlers are supported. Flushes end 500 ms before the invocation's deadline,
  so an unreachable collector does not make invocations time out.

  ```js
  import { withFlush } from "@clickhouse/clickstack-node";

  export const handler = withFlush(async (event) => {
    console.log("order received", event.id);
    return { statusCode: 200 };
  });
  ```

- The flag does nothing in worker threads. `init` in a worker starts an SDK for that worker only.

## Next.js

Call `init` from `register()` in `instrumentation.ts`, in the Node.js runtime only, and keep the
package out of the server bundle:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@clickhouse/clickstack-node");
    init();
  }
}
```

```js
// next.config.mjs
export default {
  serverExternalPackages: ["@clickhouse/clickstack-node"],
};
```

- Each request has two server spans: the HTTP instrumentation's `GET`, which continues the
  incoming trace, and Next.js's own `GET /route` under it.
- Requests for static files can be half of the HTTP instrumentation's server spans. Ignoring them
  drops every span of those requests; with `basePath`, put it in front of the path:

  ```ts
  init({
    instrumentations: {
      "@opentelemetry/instrumentation-http": {
        ignoreIncomingRequestHook: (req) =>
          req.url?.startsWith("/_next/static/") === true,
      },
    },
  });
  ```

- Next.js sets `http.route` on the HTTP instrumentation's server span after the response may have
  ended, which logs `Cannot execute the operation on ended Span` at the default log level.
  `OTEL_LOG_LEVEL=error` hides these lines; export errors still print.
- On SIGTERM or SIGINT, `next start` and the standalone `server.js` exit as soon as the server
  closes, before the SDK's flush ends, so the last spans, logs and metrics are lost. With
  `NEXT_MANUAL_SIG_HANDLE=true` in the server's environment, Next.js leaves signals to the SDK,
  which flushes and exits, and no longer waits for requests in flight.
- A warning such as `Error: 'import-in-the-middle' failed to wrap 'file:///app/node_modules/zod/index.js'`
  means that the ES module loader hook could not wrap that module. It loads unchanged, and only an
  instrumentation of that package would miss it. `--trace-warnings` shows the cause;
  `NODE_OPTIONS=--disable-warning=Error` hides these lines, along with any other warning issued as
  a plain error.

## Compatibility

- Node.js 22.15 or later. CI runs the latest 22, 24 and 26. Windows is not tested.
- OpenTelemetry JS 2.x: `@opentelemetry/sdk-node` `^0.223.0`, `@opentelemetry/core` `^2.12.0` and
  `@opentelemetry/auto-instrumentations-node` `^0.81.0`, with `@opentelemetry/api`
  `>=1.9.1 <1.10.0`.
- ES modules: the flag uses synchronous loader hooks on Node.js 22.22.3 or later, 24.11.1 or later
  and 26, and `module.register()` on earlier versions and where `require()` of ES modules is off,
  such as AWS Lambda. With `module.register()`, a named import from `node:http` after the import of
  a package that loads `node:http` itself stays uninstrumented (import `node:http` first), and an ES
  module entry file needs a file extension.
- Default imports of CommonJS packages: the default export does not see functions that an
  instrumentation replaces on the package's exports. With `import grpc from "@grpc/grpc-js"`, gRPC
  client calls get no spans; use `import * as grpc from "@grpc/grpc-js"` or named imports.
- TypeScript: CommonJS TypeScript fails under any ES module loader hook on Node.js 22 and on 24.0
  to 24.11, so use `--require` there. With ts-node, or any transpiler that hooks `require`, always
  use `--require`: any `--import`, also in `NODE_OPTIONS`, makes Node.js load the `.ts` entry
  through the ES module loader, past the transpiler. Both flags install the ES module loader hook.
- Bundlers: code that a bundler inlined cannot be instrumented, and nothing warns. Keep this
  package and the instrumented libraries external (esbuild `--packages=external`, webpack
  `externals`, Next.js `serverExternalPackages`); for Next.js, see [Next.js](#nextjs).
- ClickStack: any version that accepts the ingestion key as a bare `authorization` header.

## License

[Apache-2.0](LICENSE)

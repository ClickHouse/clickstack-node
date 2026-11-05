import type * as AutoInstrumentations from "@opentelemetry/auto-instrumentations-node";
import type * as Console from "@opentelemetry/instrumentation-console";
import type * as Resources from "@opentelemetry/resources";
import type * as SdkNode from "@opentelemetry/sdk-node";

/** The parts of the SDK packages that `init` uses. */
export interface Sdk {
  readonly NodeSDK: typeof SdkNode.NodeSDK;
  readonly getNodeAutoInstrumentations: typeof AutoInstrumentations.getNodeAutoInstrumentations;
  readonly getResourceDetectors: typeof AutoInstrumentations.getResourceDetectors;
  readonly ConsoleInstrumentation: typeof Console.ConsoleInstrumentation;
  readonly defaultResource: typeof Resources.defaultResource;
  readonly resourceFromAttributes: typeof Resources.resourceFromAttributes;
}

/**
 * Loads the SDK packages when `init` starts the SDK, not when the package is imported. Loading
 * them takes hundreds of milliseconds, which apps that only import `flush` or `shutdown`, or set
 * `OTEL_SDK_DISABLED`, should not pay. They also have to load after the ES module loader hook:
 * builds that import `node:http` or `node:fs` as they load would keep the app's named imports of
 * those builtins unpatched. The `require` calls take literal names, so that file tracers copy the
 * packages (see tsdown.config.ts).
 *
 * @returns The SDK functions and classes.
 */
export function loadSdk(): Sdk {
  const auto =
    require("@opentelemetry/auto-instrumentations-node") as typeof AutoInstrumentations;
  const resources = require("@opentelemetry/resources") as typeof Resources;

  return {
    NodeSDK: (require("@opentelemetry/sdk-node") as typeof SdkNode).NodeSDK,
    getNodeAutoInstrumentations: auto.getNodeAutoInstrumentations,
    getResourceDetectors: auto.getResourceDetectors,
    ConsoleInstrumentation: (
      require("@opentelemetry/instrumentation-console") as typeof Console
    ).ConsoleInstrumentation,
    defaultResource: resources.defaultResource,
    resourceFromAttributes: resources.resourceFromAttributes,
  };
}

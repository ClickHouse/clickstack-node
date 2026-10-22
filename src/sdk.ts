import { createRequire } from "node:module";
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
 * Loads the SDK packages, which must happen after the ES module loader hook is installed. Their ES
 * module builds import `node:http`, `node:fs` and other instrumented builtins as they load (the
 * cloud resource detectors, the Zipkin and Prometheus exporters, the machine ID lookup), and a
 * builtin imported before the hook keeps the app's named imports of it unpatched. A static import
 * would load them before `init` runs, so they are required here.
 *
 * @returns The SDK functions and classes.
 */
export function loadSdk(): Sdk {
  const load = createRequire(import.meta.url);
  const auto = load(
    "@opentelemetry/auto-instrumentations-node",
  ) as typeof AutoInstrumentations;
  const resources = load("@opentelemetry/resources") as typeof Resources;
  return {
    NodeSDK: (load("@opentelemetry/sdk-node") as typeof SdkNode).NodeSDK,
    getNodeAutoInstrumentations: auto.getNodeAutoInstrumentations,
    getResourceDetectors: auto.getResourceDetectors,
    ConsoleInstrumentation: (
      load("@opentelemetry/instrumentation-console") as typeof Console
    ).ConsoleInstrumentation,
    defaultResource: resources.defaultResource,
    resourceFromAttributes: resources.resourceFromAttributes,
  };
}

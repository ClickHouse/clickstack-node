import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
} from "@opentelemetry/semantic-conventions";

const MAX_CAUSES = 5;

/**
 * Builds the `exception.*` attributes of the crash record that the logs SDK does not derive from
 * the error itself. Attributes set here win over the SDK's.
 *
 * @remarks
 * An error's `cause` chain, up to five deep, is appended to its stack as `Caused by:` sections, the
 * layout of Java's `printStackTrace`, which ClickStack splits on. A thrown value that is not an
 * error is recorded as JSON text, because the logs SDK records only strings and numbers. Stacks
 * stay raw; ClickStack parses them.
 *
 * @param value - The uncaught exception.
 * @returns The attributes; empty when the SDK's own are complete.
 */
export function exceptionAttributes(value: unknown): Attributes {
  try {
    if (typeof value === "string") return {};
    if (!isErrorLike(value)) return { [ATTR_EXCEPTION_MESSAGE]: toText(value) };
    const { cause } = value as { cause?: unknown };

    return cause === undefined
      ? {}
      : { [ATTR_EXCEPTION_STACKTRACE]: stackWithCauses(value) };
  } catch {
    // The SDK's own attributes still describe the error.
    return {};
  }
}

function isErrorLike(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    ("message" in value || "stack" in value)
  );
}

function stackWithCauses(error: object): string {
  let text = errorText(error);
  const seen = new Set<unknown>([error]);
  let { cause } = error as { cause?: unknown };
  for (
    let depth = 0;
    depth < MAX_CAUSES && cause !== undefined && !seen.has(cause);
    depth++
  ) {
    seen.add(cause);

    text += `\nCaused by: ${isErrorLike(cause) ? errorText(cause) : toText(cause)}`;
    cause = isErrorLike(cause)
      ? (cause as { cause?: unknown }).cause
      : undefined;
  }

  return text;
}

// The "Name: message" line followed by the frames. A V8 stack starts with that line already.
function errorText(error: object): string {
  const header = Error.prototype.toString.call(error);
  const { stack } = error as { stack?: unknown };

  if (typeof stack !== "string") return header;

  return stack.startsWith(header) ? stack : `${header}\n${stack}`;
}

function toText(value: unknown): string {
  try {
    // Typed as string, but undefined for undefined, functions and symbols.
    const json = JSON.stringify(value) as string | undefined;
    if (json !== undefined) return json;
  } catch {
    // A circular structure or a BigInt.
  }

  return String(value);
}

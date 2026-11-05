import { describe, expect, it } from "vitest";
import { loadSdk } from "./sdk.ts";

describe("loadSdk", () => {
  it("loads the SDK functions and classes", () => {
    const sdk = loadSdk();

    for (const value of Object.values(sdk))
      expect(value).toBeTypeOf("function");
  });
});

import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Attributes, Span } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpBodyHooks } from "./http.ts";

function fakeSpan(recording = true): Span & { attributes: Attributes } {
  const attributes: Attributes = {};

  return {
    attributes,
    isRecording: () => recording,
    setAttributes(a: Attributes) {
      Object.assign(attributes, a);
      return this;
    },
  } as unknown as Span & { attributes: Attributes };
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

// Mimics instrumentation-http on the server side: request and response hooks before the handler,
// finalize when the response closes.
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  span = fakeSpan(),
): Promise<{
  port: number;
  span: Span & { attributes: Attributes };
  done: Promise<void>;
}> {
  const hooks = createHttpBodyHooks();
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });

  server = createServer((req, res) => {
    hooks.requestHook(span, req);
    hooks.responseHook(span, res);

    res.on("close", () => {
      hooks.finalize(span);
      finished();
    });

    handler(req, res);
  });

  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

  return { port: (server.address() as AddressInfo).port, span, done };
}

function post(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { port, method: "POST", host: "127.0.0.1", headers },
      (res) => {
        let text = "";

        res.setEncoding("utf8");

        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () => {
          resolve(text);
        });
      },
    );

    req.on("error", reject);
    req.end(body);
  });
}

describe("node:http server bodies", () => {
  it.each([
    [
      "on data",
      (req: IncomingMessage, end: (s: string) => void) => {
        let s = "";

        req.on("data", (c: Buffer) => {
          s += c.toString();
        });
        req.on("end", () => {
          end(s);
        });
      },
    ],
    [
      "read()",
      (req: IncomingMessage, end: (s: string) => void) => {
        let s = "";

        req.on("readable", () => {
          let c: Buffer | null;
          while ((c = req.read() as Buffer | null) !== null) s += c.toString();
        });
        req.on("end", () => {
          end(s);
        });
      },
    ],
    [
      "for await with setEncoding",
      (req: IncomingMessage, end: (s: string) => void) => {
        req.setEncoding("utf8");

        void (async () => {
          let s = "";

          for await (const c of req) s += c as string;

          end(s);
        })();
      },
    ],
  ])(
    "sees the bytes the app reads with %s, without changing them",
    async (_name, consume) => {
      const { port, span, done } = await serve((req, res) => {
        consume(req, (s) => res.end(s));
      });

      const body = '{"password":"x","n":1}';

      expect(
        await post(port, body, { "content-type": "application/json" }),
      ).toBe(body);

      await done;

      expect(span.attributes["http.request.body.content"]).toBe(
        '{"password":"[REDACTED]","n":1}',
      );
      expect(span.attributes["http.request.body.size"]).toBe(body.length);
    },
  );

  it("forwards every write and end argument form unchanged", async () => {
    const calls: string[] = [];
    const { port, span, done } = await serve((req, res) => {
      req.resume();
      res.setHeader("content-type", "text/plain");

      expect(res.write("a", () => calls.push("write cb"))).toBe(true);

      res.write("62", "hex");
      res.end(Buffer.from("c"), () => calls.push("end cb"));
    });

    expect(await post(port, "")).toBe("abc");

    await done;

    expect(calls).toEqual(["write cb", "end cb"]);
    expect(span.attributes["http.response.body.content"]).toBe("abc");
  });

  it("reads headers given straight to writeHead, as Fastify sends them", async () => {
    const { port, span, done } = await serve((req, res) => {
      req.resume();
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end('{"token":"t"}');
    });

    await post(port, "");
    await done;

    expect(span.attributes["http.response.body.content"]).toBe(
      '{"token":"[REDACTED]"}',
    );
  });

  it("finalizes when the response errors, which upstream ends without its hook", async () => {
    const { port, span, done } = await serve((req, res) => {
      req.resume();
      res.setHeader("content-type", "text/plain");
      res.end("done");
      res.on("error", () => undefined);
      res.write("late");
    });

    await post(port, "");
    await done;

    expect(span.attributes["http.response.body.content"]).toBe("done");
  });

  it("records nothing for a span that is not recording", async () => {
    const { port, span, done } = await serve((req, res) => {
      req.resume();
      res.end("body");
    }, fakeSpan(false));

    await post(port, "x");
    await done;

    expect(span.attributes).toEqual({});
  });
});

describe("node:http client bodies", () => {
  it("records the request body when the connection fails", async () => {
    const hooks = createHttpBodyHooks();
    const span = fakeSpan();
    const req = httpRequest({
      port: 1,
      host: "127.0.0.1",
      method: "POST",
      headers: { "content-type": "text/plain" },
    });

    hooks.requestHook(span, req);

    const failed = new Promise((resolve) => req.on("error", resolve));
    req.end("sent anyway");

    await failed;

    expect(span.attributes["http.request.body.content"]).toBe("sent anyway");
  });
});

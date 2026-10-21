// ES module app with named node:http imports, which only the ESM loader hook can instrument.
import { createServer, get } from "node:http";

const state = globalThis[Symbol.for("@clickhouse/clickstack-node")];
const server = createServer((request, response) => {
  console.log(`handled ${request.method} ${request.url}`);
  response.end("ok\n");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();

  get(`http://127.0.0.1:${port}/hello`, (response) => {
    response.resume();
    response.on("end", () => {
      process.stdout.write(`READY ${port} hook=${state?.esmHook}\n`);
      server.close();
    });
  });
});

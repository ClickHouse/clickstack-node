"use strict";
// CommonJS app: serves one request to itself, logs it, prints READY, then exits unless told
// otherwise. --init calls init() with FIXTURE_OPTIONS; --serve keeps serving; --own-signal adds
// an app SIGTERM handler; --crash throws an error with a cause; --throw-value throws an object;
// --reject leaves a rejected promise.
const argv = process.argv.slice(2);
if (argv.includes("--init")) {
  require("@clickhouse/clickstack-node").init(
    JSON.parse(process.env.FIXTURE_OPTIONS ?? "{}"),
  );
}
const http = require("node:http");

if (argv.includes("--own-signal")) {
  process.on("SIGTERM", () => {
    process.stdout.write("app got SIGTERM\n");
    setTimeout(() => process.exit(0), 500);
  });
}

const server = http.createServer((request, response) => {
  console.log(`handled ${request.method} ${request.url}`);

  response.setHeader("content-type", "text/plain");
  response.end("ok\n");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();

  http.get(`http://127.0.0.1:${port}/hello`, (response) => {
    response.resume();
    response.on("end", () => {
      process.stdout.write(`READY ${port}\n`);

      if (argv.includes("--crash")) {
        setTimeout(() => {
          throw new Error("fixture crash", {
            cause: new TypeError("fixture cause"),
          });
        }, 0);
      } else if (argv.includes("--throw-value")) {
        setTimeout(() => {
          throw { code: 1 };
        }, 0);
      } else if (argv.includes("--reject")) {
        void Promise.reject(new Error("fixture rejection"));
      } else if (!argv.includes("--serve") && !argv.includes("--own-signal")) {
        server.close();
      }
    });
  });
});

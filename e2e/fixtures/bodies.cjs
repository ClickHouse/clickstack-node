"use strict";
// Exercises body capture against its own server and prints `RESULT <json>` with the hashes the
// app saw, which must not depend on whether capture is on.
const { createHash } = require("node:crypto");
const http = require("node:http");
const { pipeline } = require("node:stream/promises");

const sha = (data) => createHash("sha256").update(data).digest("hex");
const upload = Buffer.alloc(10 * 1024 * 1024, "abcdefghij");

const server = http.createServer(async (req, res) => {
  if (req.url === "/upload") {
    const hash = createHash("sha256");

    await pipeline(req, hash);

    res.end(hash.digest("hex"));
  } else if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream" });

    for (let i = 0; i < 50; i++) res.write(`data: {"n":${i}}\n\n`);

    res.end();
  } else {
    let body = "";
    req.setEncoding("utf8");

    for await (const chunk of req) body += chunk;

    res.setHeader("content-type", "application/json");
    res.setHeader("x-request-id", "r-1");
    res.end(JSON.stringify({ echoed: body.length, token: "server-secret" }));
  }
});

function request(port, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, path, method, headers, host: "127.0.0.1" },
      (res) => {
        const chunks = [];

        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );

    req.on("error", reject);
    req.end(body);
  });
}

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  const json = {
    "content-type": "application/json",
    authorization: "Bearer abc",
  };

  await request(
    port,
    "/json",
    "POST",
    json,
    JSON.stringify({ user: "ada", password: "hunter2" }),
  );

  // fetch labels a string body text/plain;charset=UTF-8.
  await (
    await fetch(`http://127.0.0.1:${port}/fetch`, {
      method: "POST",
      body: '{"token":"t1"}',
    })
  ).text();

  const uploaded = (
    await request(port, "/upload", "POST", {}, upload)
  ).toString();
  const sse = sha(await request(port, "/sse", "GET", {}));

  process.stdout.write(
    `RESULT ${JSON.stringify({ uploadOk: uploaded === sha(upload), sse })}\n`,
  );
  process.stdout.write("READY\n");

  server.close();
});

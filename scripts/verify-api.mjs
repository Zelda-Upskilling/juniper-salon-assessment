import assert from "node:assert/strict";
const cases = [
  ["GET", "/api/missing", undefined, 404],
  ["POST", "/api/command", "{", 400],
  [
    "POST",
    "/api/command",
    JSON.stringify({ requestId: "invalid-start", type: "start" }),
    400,
  ],
  [
    "POST",
    "/api/command",
    JSON.stringify({
      requestId: "invalid-response",
      type: "reply",
      offerId: "missing",
      reply: "wrong",
    }),
    400,
  ],
  [
    "POST",
    "/api/command",
    JSON.stringify({
      requestId: "oversized",
      type: "withdraw",
      text: "x".repeat(40000),
    }),
    413,
  ],
];
for (const [method, path, body, status] of cases) {
  const response = await fetch("http://127.0.0.1:3000" + path, {
    method,
    body,
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal((await response.json()).ok, false);
  console.log(`PASS ${status} ${path}`);
}

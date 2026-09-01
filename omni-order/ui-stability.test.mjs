import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(brace + 1, index);
  }
  throw new Error(`Could not parse ${name}`);
}

test("background polling updates one card without rebuilding the order grid", () => {
  const body = functionBody("pollOrder");
  assert.match(body, /updateOrderCard\(recordId\)/);
  assert.doesNotMatch(body, /\brender\(\)/);
});

test("submitting one share link keeps the other cards mounted", () => {
  const body = functionBody("submitOrder");
  assert.match(body, /updateOrderCard\(recordId\)/);
  assert.doesNotMatch(body, /\brender\(\)/);
});

test("saving state does not reorder completed cards", () => {
  const body = functionBody("saveState");
  assert.doesNotMatch(body, /state\.orders\s*=/);
  assert.doesNotMatch(body, /\.sort\s*\(/);
});

test("claim requests can include selected pending-view row numbers", () => {
  const body = functionBody("claimBatch");
  assert.match(body, /rowNumbers/);
  assert.match(source, /function parseRowNumbers\(/);
  const parse = new Function("value", "MAX_ACTIVE_ORDERS", functionBody("parseRowNumbers"));
  assert.deepEqual(parse("2, 4, 8-10", 100), [2, 4, 8, 9, 10]);
  assert.throws(() => parse("10-8", 100), /范围无效/);
});

test("batch claims use the asynchronous job API and persist recovery state before polling", () => {
  const body = functionBody("claimBatch");
  assert.match(body, /\/api\/order\/claim-batch\/start/);
  assert.match(body, /claimJobId/);
  assert.match(source, /function pollClaimBatch\(/);
});

test("recovery can rebuild cards by assignee when browser lock data is missing", () => {
  const body = functionBody("recoverOrders");
  assert.match(body, /\/api\/order\/recover-by-assignee/);
  assert.match(body, /api\("\/api\/order\/recover"/);
  assert.match(body, /mergeRecoveredOrders/);
});

test("Doubao submission continues when Cloudflare cannot extract fallback_api", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const resolveDoubaoFallback = new AsyncFunction("shareUrl", "RESOLVER", "fetch", functionBody("resolveDoubaoFallback"));
  const result = await resolveDoubaoFallback(
    "https://www.doubao.com/thread/xVy9XavoQmbpFO6Rw",
    "https://resolver.test",
    async () => new Response(JSON.stringify({ error: "当前网络没有读取到豆包视频数据，请稍后重试" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(result, "");
});

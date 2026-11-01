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

test("completed cards can be cleared while a batch is still submitting", () => {
  const els = Object.fromEntries(["assignee", "rowNumbers", "quantity", "claim", "recover", "submitAll", "releaseAll", "clearCompleted"].map((key) => [key, { value: "", querySelector: () => ({}) }]));
  const state = { assignee: "test", orders: [{ state: "completed" }, { state: "submitting" }] };
  const controls = new Function("els", "state", "activeOrders", "detectPlatform", "batchBusy", "claimBusy", "serverOnline", "MAX_ACTIVE_ORDERS", "recoveryBusy", functionBody("renderControls"));
  controls(els, state, () => [state.orders[1]], () => ({}), true, false, true, 100, false);
  assert.equal(els.clearCompleted.disabled, false);
  const clear = new Function("state", "saveState", "render", "setDeck", functionBody("clearFinishedCards"));
  clear(state, () => {}, () => {}, () => {});
  assert.deepEqual(state.orders, [{ state: "submitting" }]);
});

test("clearing historical cards keeps active DOM nodes and does not reload their images", () => {
  const children = [];
  const active = { dataset: { recordId: "active" }, input: "draft", querySelector: () => ({}) };
  const done = { dataset: { recordId: "done" }, remove() { children.splice(children.indexOf(this), 1); } };
  children.push(done, active);
  const state = { orders: [{ recordId: "active", state: "claimed" }] };
  const els = { grid: { children, appendChild() {} }, empty: { classList: { toggle() {} } } };
  const render = new Function("state", "els", "document", "syncOrderCard", "renderOrder", "renderMetrics", "renderControls", "pad", functionBody("render"));
  let updated = 0;
  render(state, els, { createDocumentFragment: () => ({ appendChild() {} }) }, (card) => { assert.equal(card, active); updated++; }, () => { throw new Error("existing card must not be recreated"); }, () => {}, () => {}, String);
  assert.deepEqual(children, [active]);
  assert.equal(active.input, "draft");
  assert.equal(updated, 1);
});

test("a rejected batch submission releases the busy state", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("state", "detectPlatform", "setDeck", "renderControls", "runPool", "submitOrder", `let batchBusy = false; try { ${functionBody("submitAllReady")} } finally { return batchBusy; }`);
  const busy = await run({ orders: [{ state: "claimed", shareUrl: "valid" }] }, () => ({ platform: "豆包" }), () => {}, () => {}, async () => { throw new Error("storage failure"); }, () => {});
  assert.equal(busy, false);
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

test("returning from the file chooser does not trigger automatic recovery", () => {
  const body = functionBody("bootstrap");
  assert.doesNotMatch(body, /addEventListener\("focus"|visibilitychange/);
  assert.match(body, /recoverOrders\(true\)/);
});

test("recovery retires a stale processing card when the backend no longer owns its lock", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const state = { assignee: "worker", orders: [{ recordId: "stale", lockId: "old-lock", state: "processing" }] };
  const calls = [];
  const run = new AsyncFunction(
    "silent", "state", "activeOrders", "api", "mergeRecoveredOrders", "clearPendingClaim", "saveState", "render",
    "startPendingPollers", "renderControls", "setDeck", "showToast", "els", "MAX_ACTIVE_ORDERS", "setTimeout", "clearTimeout",
    `let recoveryBusy = false; let lastRecoveryAt = 0; const activeFileUploads = new Set(); ${functionBody("recoverOrders")}`,
  );
  await run(
    false,
    state,
    () => state.orders.filter((order) => !["completed", "lost"].includes(order.state)),
    async (path) => {
      calls.push(path);
      if (path.endsWith("recover-by-assignee")) return { ok: true, orders: [] };
      if (path.endsWith("/recover")) return { ok: true, orders: [], missing: [{ recordId: "stale", retryable: false }] };
      throw new Error(`unexpected API ${path}`);
    },
    (_orders, missing) => {
      if (missing instanceof Set && missing.has("stale")) state.orders[0].state = "lost";
    },
    () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, {}, 100, setTimeout, clearTimeout,
  );
  assert.deepEqual(calls, ["/api/order/recover", "/api/order/recover-by-assignee"], "local lock reconciliation must run before assignee recovery");
  assert.deepEqual(state.orders, []);
});

test("upload survives concurrent recovery and completes only after confirmed writeback", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const state = { assignee: "worker", orders: [{ recordId: "r1", lockId: "l1", state: "claimed" }] };
  const activeFileUploads = new Set();
  const findOrder = (id) => state.orders.find((item) => item.recordId === id);
  const merge = new Function("state", "activeFileUploads", "normalizeOrder", "recoveredOrders", "missing", functionBody("mergeRecoveredOrders"));
  let finishUpload;
  const pendingUpload = new Promise((resolve) => { finishUpload = resolve; });
  let finishWriteback;
  const pendingWriteback = new Promise((resolve) => { finishWriteback = resolve; });
  const api = async (path) => path.endsWith("/prepare") ? { ok: true, ticket: "ticket" } : pendingWriteback;
  const noop = () => {};
  const finalize = new AsyncFunction("recordId", "findOrder", "activeFileUploads", "saveState", "updateOrderCard", "api", "showToast", "shortId", functionBody("finalizeOrderFile"));
  const upload = new AsyncFunction("recordId", "file", "findOrder", "activeFileUploads", "MAX_ORDER_FILE_BYTES", "saveState", "updateOrderCard", "api", "state", "putOrderFile", "normalizeHttpUrl", "finalizeOrderFile", functionBody("uploadOrderFile"));
  const task = upload("r1", { name: "muse.mp4", type: "video/mp4", size: 4 }, findOrder, activeFileUploads, 1000, noop, noop, api, state, () => pendingUpload, String, (id) => finalize(id, findOrder, activeFileUploads, noop, noop, api, noop, String));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(findOrder("r1").state, "uploading");
  const original = findOrder("r1");
  merge(state, activeFileUploads, (x) => x, [{ recordId: "r1", lockId: "l1", state: "claimed", message: "已恢复接单状态" }], false);
  assert.equal(findOrder("r1"), original);
  assert.equal(original.state, "uploading");
  finishUpload({ videoUrl: "https://r2.test/video.mp4" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(findOrder("r1").state, "submitting");
  assert.equal(findOrder("r1").fileUploadTicket, "ticket");
  finishWriteback({ ok: true, status: "completed", videoUrl: "https://r2.test/video.mp4" });
  await task;
  assert.equal(findOrder("r1").state, "completed");
  assert.equal(activeFileUploads.size, 0);
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

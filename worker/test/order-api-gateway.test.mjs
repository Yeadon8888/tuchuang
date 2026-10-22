import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

test("proxies only an allowlisted order API path to the fixed origin", async (t) => {
  let captured;
  const env = { ORDER_API: { fetch: async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ ok: true, features: ["multi-platform-order-web"] }), {
      headers: { "Content-Type": "application/json" },
    });
  } } };

  const response = await worker.fetch(new Request("https://edge.example/order-api/api/order/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignee: "test" }),
  }), env);

  assert.equal(response.status, 200);
  assert.equal(captured.url, "http://127.0.0.1:8787/api/order/recover");
  assert.equal(captured.init.method, "POST");
  assert.equal(new TextDecoder().decode(captured.init.body), JSON.stringify({ assignee: "test" }));
  assert.equal(response.headers.get("X-Mailab-Route"), "cloudflare");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("preserves image proxy query parameters", async (t) => {
  let capturedUrl = "";
  const env = { ORDER_API: { fetch: async (url) => {
    capturedUrl = String(url);
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
  } } };

  const response = await worker.fetch(new Request("https://edge.example/order-api/api/image-proxy?url=https%3A%2F%2Fexample.com%2Fa.jpg&preview=1"), env);

  assert.equal(response.status, 200);
  assert.equal(capturedUrl, "http://127.0.0.1:8787/api/image-proxy?url=https%3A%2F%2Fexample.com%2Fa.jpg&preview=1");
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
});

test("rejects paths outside the order API allowlist", async () => {
  const response = await worker.fetch(new Request("https://edge.example/order-api/api/admin", { method: "POST" }), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "不支持的接单 API 路径" });
});

test("allows asynchronous batch claim and assignee recovery routes", async (t) => {
  const captured = [];
  const env = { ORDER_API: { fetch: async (url) => {
    captured.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } } };

  for (const path of [
    "/api/order/claim-batch/start",
    "/api/order/claim-batch/status",
    "/api/order/recover-by-assignee",
  ]) {
    const response = await worker.fetch(new Request(`https://edge.example/order-api${path}`, { method: "POST", body: "{}" }), env);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(captured, [
    "http://127.0.0.1:8787/api/order/claim-batch/start",
    "http://127.0.0.1:8787/api/order/claim-batch/status",
    "http://127.0.0.1:8787/api/order/recover-by-assignee",
  ]);
});

test("streams an authorized order video directly into R2 without proxying bytes to the origin", async () => {
  const captured = { apiBodies: [], puts: [] };
  const env = {
    MAX_UPLOAD_BYTES: "104857600",
    ORDER_API: {
      fetch: async (url, init) => {
        captured.apiBodies.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
        return new Response(JSON.stringify({
          ok: true,
          objectKey: "mailab/videos/2026/10/22/rec1-test.mp4",
          publicUrl: "https://r2.test/mailab/videos/2026/10/22/rec1-test.mp4",
          contentType: "video/mp4",
          fileSize: 4,
          fileName: "muse.mp4",
        }), { headers: { "Content-Type": "application/json" } });
      },
    },
    IMAGES: {
      put: async (key, body, options) => {
        captured.puts.push({ key, body: [...new Uint8Array(await new Response(body).arrayBuffer())], options });
        return { key };
      },
    },
  };
  const response = await worker.fetch(new Request("https://edge.example/order-file-upload", {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": "4",
      "X-Upload-Ticket": "ticket-1",
    },
    body: new Uint8Array([1, 2, 3, 4]),
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    uploaded: true,
    ticket: "ticket-1",
    videoUrl: "https://r2.test/mailab/videos/2026/10/22/rec1-test.mp4",
    size: 4,
  });
  assert.equal(captured.apiBodies[0].url, "http://127.0.0.1:8787/api/order/file-upload/authorize");
  assert.deepEqual(captured.apiBodies[0].body, { ticket: "ticket-1", contentLength: 4, contentType: "video/mp4" });
  assert.deepEqual(captured.puts[0].body, [1, 2, 3, 4]);
});

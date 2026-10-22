import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "../src/index.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("serves the order API natively from Cloudflare without an origin binding", async () => {
  const response = await worker.fetch(new Request("https://edge.example/order-api/api/health"), {
    FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret", FEISHU_APP_TOKEN: "base-token", FEISHU_TABLE_ID: "table-id",
    ORDER_DB: {}, ORDER_JOBS: {}, ORDER_VIDEOS: {}, R2_PUBLIC_BASE_URL: "https://r2.test",
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.runtime, "cloudflare");
  assert.equal(data.originServerRequired, false);
  assert.ok(data.features.includes("cloudflare-native-order-api"));
  assert.equal(response.headers.get("X-Mailab-Route"), "cloudflare-native");
});

test("rejects paths outside the Cloudflare-native order API allowlist", async () => {
  const response = await worker.fetch(new Request("https://edge.example/order-api/api/admin", { method: "POST" }), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: "不支持的接单 API 路径" });
});

test("proxies order images at the edge without using the origin server", async () => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://image.example/a.jpg");
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
  };
  const response = await worker.fetch(new Request("https://edge.example/order-api/api/image-proxy?url=https%3A%2F%2Fimage.example%2Fa.jpg"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test("streams an authorized order video into the archive R2 bucket without an origin binding", async () => {
  const puts = [];
  const ticketRow = {
    ticket: "ticket-1", record_id: "rec1", lock_id: "lock1", assignee: "tester",
    file_name: "muse.mp4", file_size: 4, content_type: "video/mp4",
    object_key: "mailab/videos/2026/10/22/rec1-test.mp4",
    public_url: "https://r2.test/mailab/videos/2026/10/22/rec1-test.mp4",
    status: "prepared", expires_at: Date.now() + 60_000,
  };
  const env = createEnv({ ticketRow, puts });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "token", expire: 7200 });
    if (url.includes("/records/rec1")) return Response.json({ code: 0, data: { record: { record_id: "rec1", fields: { 任务状态: "接单中", 接单人: "tester", 接单锁ID: "lock1" } } } });
    throw new Error(`unexpected fetch ${url}`);
  };
  const response = await worker.fetch(new Request("https://edge.example/order-file-upload", {
    method: "PUT",
    headers: { "Content-Type": "video/mp4", "Content-Length": "4", "X-Upload-Ticket": "ticket-1" },
    body: new Uint8Array([1, 2, 3, 4]),
  }), env);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).videoUrl, ticketRow.public_url);
  assert.deepEqual(puts[0].body, [1, 2, 3, 4]);
});

function createEnv({ ticketRow, puts }) {
  return {
    FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret", FEISHU_APP_TOKEN: "base-token", FEISHU_TABLE_ID: "table-id",
    R2_PUBLIC_BASE_URL: "https://r2.test", MAX_UPLOAD_BYTES: "104857600",
    ORDER_JOBS: { async send() {} },
    ORDER_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() { return sql.includes("order_upload_tickets") ? ticketRow : null; },
              async run() { return { success: true }; },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    },
    ORDER_VIDEOS: {
      async put(key, body, options) {
        puts.push({ key, body: [...new Uint8Array(await new Response(body).arrayBuffer())], options });
        return { key };
      },
    },
  };
}

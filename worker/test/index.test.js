import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "../src/index.js";

const FLOW_ID = "67064cd9-aff7-40cb-b501-521ffc7312cc";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("rejects unsupported Flow URLs before fetching", async () => {
  const env = createEnv();
  const response = await worker.fetch(new Request("https://api.example/import/flow", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Code": "1214",
    },
    body: JSON.stringify({ url: "https://example.com/video.mp4" }),
  }), env);

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /有效的 Google Flow/);
  assert.equal(env.puts.length, 0);
});

test("streams a public Flow MP4 into R2 and returns its file URL", async () => {
  const env = createEnv();
  const video = new Uint8Array([0, 1, 2, 3, 4, 5]);
  globalThis.fetch = async (url) => {
    assert.equal(url, `https://labs.google/fx/api/og-video/shared/${FLOW_ID}`);
    return new Response(video, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(video.byteLength),
      },
    });
  };

  const response = await worker.fetch(new Request("https://api.example/import/flow", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Code": "1214",
    },
    body: JSON.stringify({
      url: `https://labs.google/fx/tools/flow/shared/video/${FLOW_ID}`,
    }),
  }), env);

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.url, /^https:\/\/api\.example\/file\/temporary%2F/);
  assert.equal(result.kind, "video");
  assert.equal(result.storagePolicy, "temporary");
  assert.equal(result.size, video.byteLength);
  assert.equal(env.puts.length, 1);
  assert.deepEqual([...env.puts[0].body], [...video]);
  assert.equal(env.puts[0].options.customMetadata.sourceId, FLOW_ID);
});

test("retries a transient R2 error when uploading a file", async () => {
  const env = createEnv();
  const originalPut = env.IMAGES.put;
  let attempts = 0;
  env.IMAGES.put = async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary R2 error");
    return originalPut(...args);
  };

  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" }));
  form.set("storagePolicy", "permanent");
  form.set("uploadId", "1790664000000-a1b2c3d4");
  const response = await worker.fetch(new Request("https://api.example/upload", {
    method: "POST",
    headers: { "X-Auth-Code": "1214" },
    body: form,
  }), env);

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  const result = await response.json();
  assert.equal(result.storagePolicy, "permanent");
  assert.equal(result.key, "permanent/1790664000000-a1b2c3d4.mp4");
});

test("returns a retryable CORS error when R2 upload keeps failing", async () => {
  const env = createEnv();
  let attempts = 0;
  env.IMAGES.put = async () => {
    attempts += 1;
    throw new Error("R2 unavailable");
  };

  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" }));
  const response = await worker.fetch(new Request("https://api.example/upload", {
    method: "POST",
    headers: { "X-Auth-Code": "1214" },
    body: form,
  }), env);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(attempts, 2);
  const result = await response.json();
  assert.equal(result.retryable, true);
  assert.match(result.error, /R2 存储暂时不可用/);
});

test("serves R2 video byte ranges with a 206 response", async () => {
  const env = createEnv();
  env.IMAGES.get = async (_key, options) => {
    assert.ok(options.range instanceof Headers);
    return createR2Object({
      key: "uploads/video.mp4",
      body: new Uint8Array([2, 3, 4, 5]),
      size: 10,
      range: { offset: 2, length: 4 },
    });
  };

  const response = await worker.fetch(new Request(
    "https://api.example/file/uploads%2Fvideo.mp4",
    { headers: { Range: "bytes=2-5" } },
  ), env);

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 2-5/10");
  assert.equal(response.headers.get("Content-Length"), "4");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3, 4, 5]);
});

function createEnv() {
  const puts = [];
  return {
    AUTH_CODE: "1214",
    RETENTION_DAYS: "7",
    MAX_UPLOAD_BYTES: "104857600",
    puts,
    IMAGES: {
      async put(key, stream, options) {
        const body = new Uint8Array(await new Response(stream).arrayBuffer());
        puts.push({ key, body, options });
        return createR2Object({ key, body, size: body.byteLength, options });
      },
      async get() {
        return null;
      },
      async head() {
        return null;
      },
      async list() {
        return { objects: [], truncated: false };
      },
      async delete() {},
    },
  };
}

function createR2Object({ key, body, size, range, options = {} }) {
  const httpMetadata = options.httpMetadata || { contentType: "video/mp4" };
  return {
    key,
    size,
    range,
    uploaded: new Date(),
    httpMetadata,
    customMetadata: options.customMetadata || {},
    httpEtag: '"test-etag"',
    body: new Response(body).body,
    writeHttpMetadata(headers) {
      if (httpMetadata.contentType) headers.set("Content-Type", httpMetadata.contentType);
      if (httpMetadata.contentDisposition) {
        headers.set("Content-Disposition", httpMetadata.contentDisposition);
      }
    },
  };
}

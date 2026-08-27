const FALLBACK_AUTH_CODE = "1214";
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_PREFIX = "uploads/";
const FLOW_HOST = "labs.google";
const DOUBAO_THREAD_PATH = /^\/thread\/[^/?#]+\/?$/i;
const MAX_DOUBAO_HTML_BYTES = 4 * 1024 * 1024;
const ORDER_API_ORIGIN = "https://genvideo.mailab.top";
const ORDER_API_PREFIX = "/order-api";
const MAX_ORDER_API_BODY_BYTES = 1024 * 1024;
const ORDER_API_ROUTES = new Map([
  ["GET /api/health", true],
  ["GET /api/image-proxy", true],
  ["POST /api/order/claim-batch", true],
  ["POST /api/order/recover", true],
  ["POST /api/order/complete", true],
  ["POST /api/order/complete-status", true],
  ["POST /api/order/release-batch", true],
  ["POST /api/release", true],
]);
const FLOW_VIDEO_PATHS = [
  /^\/fx\/tools\/flow\/shared\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i,
  /^\/fx\/api\/og-video\/shared\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i,
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "DELETE, GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-Auth-Code, Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === ORDER_API_PREFIX || url.pathname.startsWith(`${ORDER_API_PREFIX}/`)) {
      return proxyOrderApi(request, url);
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({
        ok: true,
        service: "tuchuang-api",
        retentionDays: getRetentionDays(env),
        features: ["image-upload", "video-upload", "flow-import", "doubao-html-proxy", "order-api-gateway", "records", "auto-cleanup"],
      });
    }

    if (request.method === "GET" && url.pathname === "/files") {
      return listFiles(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      return uploadFile(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/import/flow") {
      return importFlowVideo(request, env, url);
    }

    if (request.method === "GET" && url.pathname === "/resolve/doubao-thread") {
      return resolveDoubaoThread(url);
    }

    if (request.method === "GET" && url.pathname === "/proxy/doubao-thread") {
      return proxyDoubaoThread(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/cleanup") {
      return cleanupNow(request, env, url);
    }

    if (url.pathname.startsWith("/file/")) {
      return handleFile(request, env, url);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupExpiredObjects(env));
  },
};

async function proxyOrderApi(request, url) {
  const upstreamPath = url.pathname.slice(ORDER_API_PREFIX.length) || "/";
  if (!ORDER_API_ROUTES.has(`${request.method} ${upstreamPath}`)) {
    return json({ error: "不支持的接单 API 路径" }, 404);
  }

  const contentLength = Number.parseInt(request.headers.get("Content-Length") || "0", 10);
  if (contentLength > MAX_ORDER_API_BODY_BYTES) {
    return json({ error: "接单 API 请求体过大" }, 413);
  }

  const upstreamUrl = new URL(upstreamPath, ORDER_API_ORIGIN);
  upstreamUrl.search = url.search;
  const headers = new Headers();
  for (const name of ["Accept", "Accept-Language", "Content-Type", "Range"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Mailab-Edge-Gateway", "tuchuang-api");

  let body;
  if (!["GET", "HEAD"].includes(request.method)) {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_ORDER_API_BODY_BYTES) {
      return json({ error: "接单 API 请求体过大" }, 413);
    }
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
  } catch {
    return json({ error: "Cloudflare 无法连接接单服务器" }, 502);
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const [name, value] of Object.entries(corsHeaders)) responseHeaders.set(name, value);
  responseHeaders.delete("Set-Cookie");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("X-Mailab-Route", "cloudflare");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function resolveDoubaoThread(url) {
  const sourceUrl = normalizeDoubaoThreadUrl(url.searchParams.get("url"));
  if (!sourceUrl) {
    return json({ error: "请输入有效的豆包公开分享链接" }, 400);
  }
  const html = await fetchDoubaoThreadHtml(sourceUrl);
  if (html instanceof Response) return html;
  const fallbackApi = extractDoubaoFallbackApi(html);
  if (!fallbackApi) {
    return json({ error: "当前网络没有读取到豆包视频数据，请稍后重试" }, 422);
  }
  return json({ ok: true, fallbackApi });
}

async function proxyDoubaoThread(request, env, url) {
  if (!isAuthorized(request.headers.get("X-Auth-Code"), env)) {
    return json({ error: "认证失败" }, 401);
  }
  const sourceUrl = normalizeDoubaoThreadUrl(url.searchParams.get("url"));
  if (!sourceUrl) {
    return json({ error: "请输入有效的豆包公开分享链接" }, 400);
  }

  const html = await fetchDoubaoThreadHtml(sourceUrl);
  if (html instanceof Response) return html;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function fetchDoubaoThreadHtml(sourceUrl) {
  let source;
  try {
    source = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      },
    });
  } catch {
    return json({ error: "无法连接豆包公开分享页" }, 502);
  }
  if (!source.ok) {
    source.body?.cancel();
    return json({ error: `豆包分享页请求失败（HTTP ${source.status}）` }, 502);
  }
  const length = Number(source.headers.get("Content-Length") || 0);
  if (length > MAX_DOUBAO_HTML_BYTES) {
    source.body?.cancel();
    return json({ error: "豆包分享页体积异常" }, 502);
  }
  const html = await source.text();
  if (!html || new TextEncoder().encode(html).byteLength > MAX_DOUBAO_HTML_BYTES) {
    return json({ error: "豆包分享页为空或体积异常" }, 502);
  }
  return html;
}

function normalizeDoubaoThreadUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:" || parsed.hostname !== "www.doubao.com" || !DOUBAO_THREAD_PATH.test(parsed.pathname)) {
      return "";
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return "";
  }
}

function extractDoubaoFallbackApi(html) {
  const text = String(html || "");
  const markerIndex = text.indexOf("fallback_api");
  if (markerIndex < 0) return "";
  const neighborhood = text.slice(Math.max(0, markerIndex - 1000), markerIndex + 8000)
    .replace(/&amp;|&#38;|&#x26;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  const candidates = neighborhood.match(/https:\/\/[^\s\"'<>\\]+/g) || [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase();
      if ((host === "snssdk.com" || host.endsWith(".snssdk.com")) && parsed.pathname.includes("/video/fplay/")) {
        return parsed.toString();
      }
    } catch {
      // Continue with the next candidate.
    }
  }
  return "";
}

async function uploadFile(request, env, url) {
  if (!isAuthorized(request.headers.get("X-Auth-Code"), env)) {
    return json({ error: "认证失败" }, 401);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "请求格式错误" }, 400);
  }

  const file = formData.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ error: "未提供文件" }, 400);
  }

  const contentType = file.type || "application/octet-stream";
  const kind = getFileKind(contentType);
  if (!kind) {
    return json({ error: "仅支持图片和视频" }, 415);
  }

  const maxUploadBytes = getMaxUploadBytes(env);
  if (file.size > maxUploadBytes) {
    return json({
      error: `文件太大，最大支持 ${formatBytes(maxUploadBytes)}`,
      maxUploadBytes,
    }, 413);
  }

  const originalName = sanitizeName(file.name || (kind === "video" ? "video" : "image"));
  const key = buildObjectKey(originalName, contentType);
  const body = await file.arrayBuffer();

  await env.IMAGES.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: {
      originalName,
      kind,
      uploadedAt: new Date().toISOString(),
    },
  });

  const item = buildFileItem(url.origin, {
    key,
    size: file.size,
    uploaded: new Date(),
    contentType,
    customMetadata: { originalName, kind },
  }, getRetentionDays(env));

  return json(item);
}

async function importFlowVideo(request, env, url) {
  if (!isAuthorized(request.headers.get("X-Auth-Code"), env)) {
    return json({ error: "认证失败" }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "请求格式错误" }, 400);
  }

  const videoId = extractFlowVideoId(payload?.url);
  if (!videoId) {
    return json({ error: "请输入有效的 Google Flow 分享链接" }, 400);
  }

  const sourceUrl = `https://${FLOW_HOST}/fx/api/og-video/shared/${videoId}`;
  let source;
  try {
    source = await fetch(sourceUrl, {
      headers: { Accept: "video/mp4,video/*;q=0.9" },
    });
  } catch {
    return json({ error: "无法连接 Google Flow，请稍后重试" }, 502);
  }

  if (!source.ok || !source.body) {
    source.body?.cancel();
    return json({ error: `Google Flow 视频获取失败（HTTP ${source.status}）` }, 502);
  }

  const contentType = normalizeContentType(source.headers.get("Content-Type"));
  if (contentType !== "video/mp4") {
    await source.body.cancel();
    return json({ error: "分享链接没有返回 MP4 视频，可能已失效或无权访问" }, 422);
  }

  const maxUploadBytes = getMaxUploadBytes(env);
  const contentLength = parseContentLength(source.headers.get("Content-Length"));
  if (!contentLength) {
    await source.body.cancel();
    return json({ error: "Google Flow 没有返回有效的视频大小" }, 502);
  }
  if (contentLength > maxUploadBytes) {
    await source.body.cancel();
    return json({
      error: `视频太大，最大支持 ${formatBytes(maxUploadBytes)}`,
      maxUploadBytes,
    }, 413);
  }

  const originalName = `flow-${videoId}.mp4`;
  const key = buildObjectKey(originalName, contentType);
  const uploadedAt = new Date().toISOString();
  let stored;

  try {
    stored = await env.IMAGES.put(key, source.body, {
      httpMetadata: {
        contentType,
        contentDisposition: `inline; filename="${originalName}"`,
      },
      customMetadata: {
        originalName,
        kind: "video",
        uploadedAt,
        source: "google-flow",
        sourceId: videoId,
      },
    });
  } catch {
    return json({ error: "写入 R2 失败，请稍后重试" }, 502);
  }

  if (!stored) {
    return json({ error: "写入 R2 失败，请稍后重试" }, 502);
  }

  const item = buildFileItem(url.origin, {
    ...stored,
    contentType,
    customMetadata: { originalName, kind: "video", uploadedAt },
  }, getRetentionDays(env));

  return json({ ...item, sourceUrl });
}

async function listFiles(request, env, url) {
  if (!isAuthorized(request.headers.get("X-Auth-Code"), env)) {
    return json({ error: "认证失败" }, 401);
  }

  const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "60", 10) || 60, 100);
  const listed = await env.IMAGES.list({ prefix: UPLOAD_PREFIX, limit: 1000 });
  const sorted = listed.objects
    .sort((a, b) => getObjectTime(b).getTime() - getObjectTime(a).getTime())
    .slice(0, limit);

  const files = await Promise.all(sorted.map(async (object) => {
    const head = await env.IMAGES.head(object.key);
    return buildFileItem(url.origin, {
      ...object,
      contentType: head?.httpMetadata?.contentType,
      customMetadata: head?.customMetadata,
    }, getRetentionDays(env));
  }));

  return json({
    files,
    retentionDays: getRetentionDays(env),
    truncated: listed.truncated,
  });
}

async function cleanupNow(request, env, url) {
  if (!isAuthorized(request.headers.get("X-Auth-Code"), env)) {
    return json({ error: "认证失败" }, 401);
  }

  const dryRun = url.searchParams.get("dryRun") === "1";
  const result = await cleanupExpiredObjects(env, { dryRun });
  return json(result);
}

async function handleFile(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice("/file/".length));

  if (request.method === "DELETE") {
    if (!isAuthorized(request.headers.get("X-Auth-Code"), env)) {
      return json({ error: "认证失败" }, 401);
    }

    await env.IMAGES.delete(key);
    return json({ ok: true, key });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const rangeHeader = request.headers.get("Range");
  let object;
  try {
    object = request.method === "HEAD"
      ? await env.IMAGES.head(key)
      : await env.IMAGES.get(key, rangeHeader ? { range: request.headers } : undefined);
  } catch {
    return new Response("Range Not Satisfiable", {
      status: rangeHeader ? 416 : 500,
      headers: corsHeaders,
    });
  }

  if (!object) {
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(object.size));
    return new Response(null, { headers });
  }

  if (object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
    headers.set("Content-Length", String(object.range.length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

async function cleanupExpiredObjects(env, options = {}) {
  const retentionMs = getRetentionDays(env) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  let cursor;
  let scanned = 0;
  let deleted = 0;
  const deletedKeys = [];

  do {
    const page = await env.IMAGES.list({ cursor, limit: 1000 });
    scanned += page.objects.length;

    const expiredKeys = page.objects
      .filter((object) => getObjectTime(object).getTime() < cutoff)
      .map((object) => object.key);

    for (const key of expiredKeys) {
      if (!options.dryRun) {
        await env.IMAGES.delete(key);
      }
      deleted += 1;
      if (deletedKeys.length < 100) deletedKeys.push(key);
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return {
    ok: true,
    dryRun: Boolean(options.dryRun),
    retentionDays: getRetentionDays(env),
    scanned,
    deleted,
    deletedKeys,
  };
}

function buildObjectKey(originalName, contentType) {
  const extension = getExtension(originalName, contentType);
  return `${UPLOAD_PREFIX}${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
}

function buildFileItem(origin, object, retentionDays) {
  const contentType = object.contentType || guessContentType(object.key);
  const kind = object.customMetadata?.kind || getFileKind(contentType) || "file";
  const name = object.customMetadata?.originalName || object.key.split("/").pop();
  const uploadedAt = getObjectTime(object).toISOString();
  const url = `${origin}/file/${encodeURIComponent(object.key)}`;

  return {
    key: object.key,
    name,
    kind,
    contentType,
    size: object.size || 0,
    uploadedAt,
    expiresAt: new Date(new Date(uploadedAt).getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString(),
    url,
    markdown: kind === "image" ? `![](${url})` : `[${name}](${url})`,
    html: kind === "image"
      ? `<img src="${url}" alt="" />`
      : `<video src="${url}" controls></video>`,
  };
}

function getObjectTime(object) {
  const fromKey = object.key.match(/(?:^|\/)(\d{13})-/)?.[1];
  if (fromKey) return new Date(Number(fromKey));
  return object.uploaded ? new Date(object.uploaded) : new Date(0);
}

function getFileKind(contentType) {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "";
}

function getExtension(name, contentType) {
  const fromName = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.replace(/[^a-z0-9]/g, "");

  const typeMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  };
  return typeMap[contentType] || "bin";
}

function extractFlowVideoId(value) {
  if (typeof value !== "string" || value.length > 2048) return "";

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }

  if (url.protocol !== "https:" || url.hostname !== FLOW_HOST || url.username || url.password) {
    return "";
  }

  for (const pattern of FLOW_VIDEO_PATHS) {
    const match = url.pathname.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return "";
}

function normalizeContentType(value) {
  return (value || "").split(";", 1)[0].trim().toLowerCase();
}

function parseContentLength(value) {
  const length = Number.parseInt(value || "", 10);
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function guessContentType(key) {
  const ext = key.toLowerCase().split(".").pop();
  const typeMap = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
  };
  return typeMap[ext] || "application/octet-stream";
}

function sanitizeName(name) {
  return name.replace(/[^\w.\-()\u4e00-\u9fa5 ]+/g, "_").slice(0, 120);
}

function getRetentionDays(env) {
  const days = Number.parseInt(env.RETENTION_DAYS || `${DEFAULT_RETENTION_DAYS}`, 10);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

function getMaxUploadBytes(env) {
  const max = Number.parseInt(env.MAX_UPLOAD_BYTES || `${DEFAULT_MAX_UPLOAD_BYTES}`, 10);
  return Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_UPLOAD_BYTES;
}

function isAuthorized(authCode, env) {
  const expected = (env.AUTH_CODE || FALLBACK_AUTH_CODE).trim();
  return authCode?.trim() === expected;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

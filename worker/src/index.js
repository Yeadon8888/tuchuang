const FALLBACK_AUTH_CODE = "1214";
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_PREFIX = "uploads/";

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

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({
        ok: true,
        service: "tuchuang-api",
        retentionDays: getRetentionDays(env),
        features: ["image-upload", "video-upload", "records", "auto-cleanup"],
      });
    }

    if (request.method === "GET" && url.pathname === "/files") {
      return listFiles(request, env, url);
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      return uploadFile(request, env, url);
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

  const object = await env.IMAGES.get(key);
  if (!object) {
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  const headers = {
    "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(object.size),
    ...corsHeaders,
  };

  if (request.method === "HEAD") {
    return new Response(null, { headers });
  }

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

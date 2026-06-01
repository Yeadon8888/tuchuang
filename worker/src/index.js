const FALLBACK_AUTH_CODE = "1214";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-Auth-Code, Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "tuchuang-api" });
    }

    // POST /upload — 上传图片
    if (request.method === "POST" && url.pathname === "/upload") {
      const authCode = request.headers.get("X-Auth-Code");
      if (!isAuthorized(authCode, env)) {
        return json({ error: "认证失败" }, 401);
      }

      let formData;
      try {
        formData = await request.formData();
      } catch {
        return json({ error: "请求格式错误" }, 400);
      }

      const file = formData.get("file");
      if (!file) {
        return json({ error: "未提供文件" }, 400);
      }

      const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
      const arrayBuffer = await file.arrayBuffer();

      await env.IMAGES.put(key, arrayBuffer, {
        httpMetadata: { contentType: "image/png" },
      });

      const imageUrl = `${url.origin}/file/${key}`;
      return json({
        url: imageUrl,
        key,
        markdown: `![](${imageUrl})`,
        html: `<img src="${imageUrl}" alt="" />`,
      });
    }

    // GET /file/:key — 读取图片
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/file/")) {
      const key = decodeURIComponent(url.pathname.slice("/file/".length));
      const object = await env.IMAGES.get(key);

      if (!object) {
        return new Response("Not Found", { status: 404 });
      }

      const headers = {
        "Content-Type": object.httpMetadata?.contentType || "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": object.size,
        ...corsHeaders,
      };

      if (request.method === "HEAD") {
        return new Response(null, { headers });
      }

      return new Response(object.body, {
        headers: {
          ...headers,
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

function isAuthorized(authCode, env) {
  const expected = (env.AUTH_CODE || FALLBACK_AUTH_CODE).trim();
  return authCode?.trim() === expected;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

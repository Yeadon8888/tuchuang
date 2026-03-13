const AUTH_CODE = "1214";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-Auth-Code, Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /upload — 上传图片
    if (request.method === "POST" && url.pathname === "/upload") {
      const authCode = request.headers.get("X-Auth-Code");
      if (authCode !== AUTH_CODE) {
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

      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const arrayBuffer = await file.arrayBuffer();

      await env.IMAGES.put(key, arrayBuffer, {
        httpMetadata: { contentType: "image/png" },
      });

      const imageUrl = `${url.origin}/file/${key}`;
      return json({ url: imageUrl, key });
    }

    // GET /file/:key — 读取图片
    if (request.method === "GET" && url.pathname.startsWith("/file/")) {
      const key = decodeURIComponent(url.pathname.slice("/file/".length));
      const object = await env.IMAGES.get(key);

      if (!object) {
        return new Response("Not Found", { status: 404 });
      }

      return new Response(object.body, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=31536000, immutable",
          ...corsHeaders,
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

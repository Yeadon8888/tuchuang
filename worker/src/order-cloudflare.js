const MAX_BATCH = 100;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 20 * 60 * 1000;
const FLOW_PATH = /^(?:\/fx\/tools\/flow\/shared\/video|\/shared\/video)\/([0-9a-f-]{36})\/?$/i;
const FPLAY_KDF_SALT_HEX = "4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58";
const TRUSTED_VIDEO_SUFFIXES = ["doubao.com", "douyin.com", "douyinvod.com", "bytecdn.cn", "byteimg.com"];

let tokenCache = { token: "", expiresAt: 0 };

export async function handleOrderApi(request, url, env, ctx) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return ok({
      appToken: mask(env.FEISHU_APP_TOKEN),
      tableId: env.FEISHU_TABLE_ID || "",
      feishuConfigured: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_APP_TOKEN && env.FEISHU_TABLE_ID),
      archiveEnabled: true,
      archiveConfigured: Boolean(env.ORDER_VIDEOS && env.R2_PUBLIC_BASE_URL),
      runtime: "cloudflare",
      originServerRequired: false,
      features: ["multi-platform-order-web", "async-batch-claim", "assignee-recovery", "direct-order-file-upload", "legacy-plugin-compatible", "cloudflare-native-order-api"],
    });
  }
  if (request.method === "GET" && url.pathname === "/api/image-proxy") return proxyOrderImage(url);
  if (request.method !== "POST") return fail("Not found", 404);

  const postRoutes = new Set([
    "/api/order/claim-batch/start", "/api/order/claim-batch/status", "/api/order/recover",
    "/api/order/recover-by-assignee", "/api/order/complete", "/api/order/complete-status",
    "/api/order/release-batch", "/api/release", "/api/order/file-upload/prepare",
    "/api/order/file-upload/authorize", "/api/order/file-upload/complete",
    "/api/claim", "/api/complete", "/api/complete-status", "/api/stats",
    "/api/omni/claim-batch", "/api/omni/recover", "/api/omni/complete",
    "/api/omni/complete-status", "/api/omni/release-batch",
  ]);
  if (!postRoutes.has(url.pathname)) return fail("不支持的接单 API 路径", 404);

  let body;
  try { body = await request.json(); }
  catch { return fail("请求 JSON 无效", 400); }

  try {
    switch (url.pathname) {
      case "/api/order/claim-batch/start": return ok(await startClaimJob(body, env));
      case "/api/order/claim-batch/status": return ok(await getJob(body.jobId, "claim", env));
      case "/api/order/recover": return ok(await recoverOrders(body, env));
      case "/api/order/recover-by-assignee": return ok(await recoverByAssignee(body, env));
      case "/api/order/complete": return ok(await startCompleteJob(body, env));
      case "/api/order/complete-status": return ok(await getJob(body.jobId, "complete", env));
      case "/api/order/release-batch": return ok(await releaseBatch(body, env));
      case "/api/release": return ok(await releaseOrder(body, env));
      case "/api/order/file-upload/prepare": return ok(await prepareOrderFileUpload(body, env));
      case "/api/order/file-upload/authorize": return ok(await authorizeOrderFileUpload(body, env));
      case "/api/order/file-upload/complete": return ok(await completeOrderFileUpload(body, env));
      case "/api/claim": return ok(await claimOneNow(body, env));
      case "/api/complete": return ok(await completeLegacy(body, env));
      case "/api/complete-status": return ok(await getJob(body.jobId, "complete", env));
      case "/api/stats": return ok(await getStats(env));
      case "/api/omni/claim-batch": return ok(await claimBatchNow({ ...body, platform: "Omni" }, env));
      case "/api/omni/recover": return ok(await recoverOrders(body, env));
      case "/api/omni/complete": return ok(await startCompleteJob({ ...body, shareUrl: body.flowShareUrl || body.shareUrl }, env));
      case "/api/omni/complete-status": return ok(await getJob(body.jobId, "complete", env));
      case "/api/omni/release-batch": return ok(await releaseBatch(body, env));
      default: return fail("不支持的接单 API 路径", 404);
    }
  } catch (error) {
    console.error("cloud order api", url.pathname, publicError(error));
    return fail(publicError(error), statusForError(error));
  }
}

export async function handleOrderQueue(batch, env) {
  for (const message of batch.messages) {
    try {
      const payload = message.body || {};
      if (payload.kind === "claim") await runClaimJob(payload.jobId, env);
      else if (payload.kind === "complete") await runCompleteJob(payload.jobId, env);
      message.ack();
    } catch (error) {
      console.error("order queue", message.id, publicError(error));
      if (isRetryable(error) && message.attempts < 4) message.retry({ delaySeconds: Math.min(300, 15 * (2 ** message.attempts)) });
      else message.ack();
    }
  }
}

async function startClaimJob(body, env) {
  requireBindings(env);
  const assignee = text(body?.assignee);
  const rowNumbers = normalizeRows(body?.rowNumbers);
  const requested = rowNumbers.length || Number.parseInt(body?.count, 10);
  const requestId = sanitizeRequestId(body?.clientRequestId);
  if (!assignee) throw new PublicError("请输入接单人", 400);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_BATCH) throw new PublicError(`批量接单数量必须是 1–${MAX_BATCH}`, 400);
  if (requestId) {
    const existing = await env.ORDER_DB.prepare("SELECT * FROM order_jobs WHERE request_id = ?").bind(requestId).first();
    if (existing) return publicJob(existing);
  }
  const now = Date.now();
  const jobId = crypto.randomUUID();
  await env.ORDER_DB.prepare(`INSERT INTO order_jobs
    (id,type,status,assignee,request_id,payload,result,message,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(jobId, "claim", "processing", assignee, requestId || null,
      JSON.stringify({ assignee, requested, rowNumbers }), "{}", "正在从飞书任务池接单", now, now, now + JOB_TTL_MS).run();
  await env.ORDER_JOBS.send({ kind: "claim", jobId });
  return publicJob(await jobRow(jobId, env));
}

async function runClaimJob(jobId, env) {
  const job = await jobRow(jobId, env);
  if (!job || job.status !== "processing") return;
  const payload = parseJson(job.payload);
  try {
    const result = await withClaimLease(env, () => performClaim(payload, env, async (claimed) => {
      await updateJobProgress(jobId, claimed, payload.requested, env);
    }));
    await finishJob(jobId, result.ok ? "completed" : "failed", result, result.ok ? `接单完成：成功 ${result.claimed} 单` : result.error, result.error, env);
  } catch (error) {
    await finishJob(jobId, "failed", {}, publicError(error), publicError(error), env);
    throw error;
  }
}

async function performClaim(payload, env, onProgress = async () => {}) {
  const records = (await listPendingRecords(env)).filter((record) => fieldText(record.fields?.[field(env, "STATUS", "任务状态")]) === status(env, "PENDING", "待接单"));
  const requestedRows = payload.rowNumbers || [];
  const entries = requestedRows.length
    ? requestedRows.map((rowNumber) => ({ rowNumber, record: records[rowNumber - 1] })).filter((item) => item.record)
    : records.slice(0, payload.requested).map((record, index) => ({ record, rowNumber: index + 1 }));
  const missing = requestedRows.filter((rowNumber) => !records[rowNumber - 1]);
  const orders = [];
  let firstError = "";
  for (const entry of entries) {
    try { orders.push(await claimRecord(entry.record, payload.assignee, entry.rowNumber, env, payload.platform)); }
    catch (error) { firstError ||= publicError(error); }
    await onProgress(orders.length);
  }
  let error = firstError;
  if (missing.length) error = [error, `待接单视图中找不到行号：${missing.join("、")}`].filter(Boolean).join("；");
  if (orders.length < payload.requested && !error) error = entries.length < payload.requested ? "当前待接单任务数量不足" : "部分任务未能完成加锁";
  return { ok: orders.length > 0, requested: payload.requested, claimed: orders.length, partial: orders.length < payload.requested, orders, error: orders.length ? error : (error || "暂无待接单任务") };
}

async function claimBatchNow(body, env) {
  requireBindings(env);
  const assignee = text(body?.assignee);
  const rowNumbers = normalizeRows(body?.rowNumbers);
  const requested = rowNumbers.length || Number.parseInt(body?.count, 10);
  if (!assignee) throw new PublicError("请输入接单人", 400);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_BATCH) throw new PublicError(`批量接单数量必须是 1–${MAX_BATCH}`, 400);
  return withClaimLease(env, () => performClaim({ assignee, requested, rowNumbers, platform: text(body?.platform) }, env));
}

async function claimOneNow(body, env) {
  const result = await claimBatchNow({ ...body, count: 1 }, env);
  if (!result.orders.length) throw new PublicError(result.error || "暂无待接单任务", 409);
  return result.orders[0];
}

async function claimRecord(record, assignee, rowNumber, env, platform = "") {
  const fields = record.fields || {};
  if (fieldText(fields[field(env, "STATUS", "任务状态")]) !== status(env, "PENDING", "待接单")) throw new Error("任务已被其他人领取");
  const lockId = crypto.randomUUID();
  const next = {
    [field(env, "STATUS", "任务状态")]: status(env, "IN_PROGRESS", "接单中"),
    [field(env, "ASSIGNEE", "接单人")]: assignee,
    [field(env, "CLAIMED_AT", "接单时间")]: Date.now(),
    [field(env, "LOCK_ID", "接单锁ID")]: lockId,
    [field(env, "LOG", "接单日志")]: appendLog(fieldText(fields[field(env, "LOG", "接单日志")]), `${assignee} 于 ${nowText()}接单 · 待接单视图第 ${rowNumber} 行`),
  };
  if (platform) next[field(env, "PLATFORM", "制作平台")] = platform;
  await updateRecord(record.record_id, next, env);
  const confirmed = await getRecord(record.record_id, env);
  if (fieldText(confirmed.fields?.[field(env, "LOCK_ID", "接单锁ID")]) !== lockId) throw new Error("接单锁确认失败，请重试");
  return buildOrder(confirmed, assignee, rowNumber, env);
}

async function withClaimLease(env, callback) {
  const holder = crypto.randomUUID();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const now = Date.now();
    const result = await env.ORDER_DB.prepare(`INSERT INTO order_leases (name,holder,expires_at) VALUES ('claim',?,?)
      ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
      WHERE order_leases.expires_at < ?`).bind(holder, now + 15 * 60_000, now).run();
    if (Number(result.meta?.changes || result.changes || 0) === 1) {
      try { return await callback(); }
      finally { await env.ORDER_DB.prepare("DELETE FROM order_leases WHERE name='claim' AND holder=?").bind(holder).run().catch(() => {}); }
    }
    await delay(300 + attempt * 200);
  }
  throw new PublicError("当前接单人数较多，请稍后重试", 409);
}

async function recoverOrders(body, env) {
  const assignee = text(body?.assignee);
  const candidates = Array.isArray(body?.orders) ? body.orders.slice(0, MAX_BATCH) : [];
  if (!assignee) throw new PublicError("请输入接单人", 400);
  const orders = [];
  const missing = [];
  for (const candidate of candidates) {
    try {
      const record = await getRecord(text(candidate.recordId), env);
      if (!owns(record, text(candidate.lockId), assignee, env)) missing.push({ recordId: candidate.recordId, reason: "订单已释放、锁已变化或不属于当前接单人" });
      else orders.push(await buildRecoveredOrder(record, assignee, env));
    } catch (error) {
      missing.push({ recordId: candidate.recordId, reason: publicError(error), retryable: isDataNotReady(error) });
    }
  }
  return { ok: true, orders, missing };
}

async function recoverByAssignee(body, env) {
  const assignee = text(body?.assignee);
  const limit = clamp(Number(body?.limit || MAX_BATCH), 1, MAX_BATCH);
  if (!assignee) throw new PublicError("请输入接单人", 400);
  const filter = `AND(CurrentValue.[${field(env, "ASSIGNEE", "接单人")}]="${escapeFilter(assignee)}",CurrentValue.[${field(env, "STATUS", "任务状态")}]="${escapeFilter(status(env, "IN_PROGRESS", "接单中"))}")`;
  const records = await listRecords(env, { filter });
  const owned = records.filter((record) => fieldText(record.fields?.[field(env, "ASSIGNEE", "接单人")]) === assignee && fieldText(record.fields?.[field(env, "LOCK_ID", "接单锁ID")]));
  const orders = [];
  for (const record of owned.slice(-limit)) orders.push(await buildRecoveredOrder(record, assignee, env));
  return { ok: true, orders, recovered: orders.length };
}

async function buildRecoveredOrder(record, assignee, env) {
  const base = buildOrder(record, assignee, extractRow(fieldText(record.fields?.[field(env, "LOG", "接单日志")])), env);
  const active = await env.ORDER_DB.prepare("SELECT id,message FROM order_jobs WHERE record_id=? AND lock_id=? AND type='complete' AND status='processing' ORDER BY created_at DESC LIMIT 1")
    .bind(base.recordId, base.lockId).first();
  return { ...base, state: active ? "processing" : "claimed", jobId: active?.id || "", message: active?.message || "已恢复接单状态" };
}

async function startCompleteJob(body, env) {
  requireBindings(env);
  const recordId = text(body?.recordId);
  const lockId = text(body?.lockId);
  const assignee = text(body?.assignee);
  const shareUrl = text(body?.shareUrl || body?.flowShareUrl);
  const platform = normalizeFlow(shareUrl) ? "Omni" : (normalizeDoubao(shareUrl) ? "豆包" : "");
  if (!recordId || !lockId || !assignee || !platform) throw new PublicError("无法识别回填链接，请粘贴有效的 Omni Flow 或豆包公开分享链接", 400);
  const record = await getRecord(recordId, env);
  assertLock(record, lockId, assignee, env);
  const existing = await env.ORDER_DB.prepare("SELECT * FROM order_jobs WHERE record_id=? AND lock_id=? AND type='complete' AND status='processing' ORDER BY created_at DESC LIMIT 1")
    .bind(recordId, lockId).first();
  if (existing) return publicJob(existing);
  const now = Date.now();
  const jobId = crypto.randomUUID();
  const normalized = platform === "Omni" ? normalizeFlow(shareUrl) : normalizeDoubao(shareUrl);
  await env.ORDER_DB.prepare(`INSERT INTO order_jobs
    (id,type,status,assignee,record_id,lock_id,payload,result,message,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(jobId, "complete", "processing", assignee, recordId, lockId,
      JSON.stringify({ recordId, lockId, assignee, platform, shareUrl: normalized, fallbackApi: text(body?.fallbackApi) }), "{}",
      platform === "Omni" ? "正在读取 Flow 视频" : "正在解析豆包无水印视频", now, now, now + JOB_TTL_MS).run();
  await updateRecord(recordId, {
    [field(env, "PLATFORM", "制作平台")]: platform,
    [field(env, "WATERMARK_URL", "去水印原始链接")]: { text: normalized, link: normalized },
    [field(env, "LAST_ERROR", "最后错误")]: "",
  }, env);
  await env.ORDER_JOBS.send({ kind: "complete", jobId });
  return { ...publicJob(await jobRow(jobId, env)), platform };
}

async function completeLegacy(body, env) {
  const directUrl = normalizePublicHttps(body?.videoUrl);
  if (!body?.directComplete || !directUrl) {
    return startCompleteJob({ ...body, shareUrl: body?.watermarkUrl || body?.shareUrl }, env);
  }
  requireBindings(env);
  const recordId = text(body?.recordId), lockId = text(body?.lockId), assignee = text(body?.assignee);
  if (!recordId || !lockId || !assignee) throw new PublicError("缺少 recordId、lockId 或接单人", 400);
  const record = await getRecord(recordId, env);
  assertLock(record, lockId, assignee, env);
  const existing = await env.ORDER_DB.prepare("SELECT * FROM order_jobs WHERE record_id=? AND lock_id=? AND type='complete' AND status='processing' ORDER BY created_at DESC LIMIT 1")
    .bind(recordId, lockId).first();
  if (existing) return { ...publicJob(existing), archiving: true };
  const now = Date.now(), jobId = crypto.randomUUID();
  await env.ORDER_DB.prepare(`INSERT INTO order_jobs
    (id,type,status,assignee,record_id,lock_id,payload,result,message,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(jobId, "complete", "processing", assignee, recordId, lockId,
      JSON.stringify({ recordId, lockId, assignee, platform: "直链", sourceUrl: directUrl }), "{}",
      "已接收视频直链，等待写入 Cloudflare R2", now, now, now + JOB_TTL_MS).run();
  await env.ORDER_JOBS.send({ kind: "complete", jobId });
  return { ...publicJob(await jobRow(jobId, env)), archiving: true };
}

async function runCompleteJob(jobId, env) {
  const job = await jobRow(jobId, env);
  if (!job || job.status !== "processing") return;
  const payload = parseJson(job.payload);
  try {
    await setJobMessage(jobId, payload.platform === "Omni" ? "正在从 Flow 获取视频" : payload.platform === "直链" ? "正在读取浏览器捕获的视频" : "正在解析豆包无水印视频", env);
    const sourceUrl = payload.platform === "Omni"
      ? flowSource(payload.shareUrl)
      : payload.platform === "直链"
        ? normalizePublicHttps(payload.sourceUrl)
        : await resolveDoubaoVideo(payload.shareUrl, payload.fallbackApi);
    if (!sourceUrl) throw new Error("视频直链无效或不可访问");
    await setJobMessage(jobId, "正在把视频流写入 Cloudflare R2", env);
    const archived = await streamVideoToR2(sourceUrl, payload, env);
    const record = await getRecord(payload.recordId, env);
    assertLock(record, payload.lockId, payload.assignee, env);
    const log = payload.platform === "Omni"
      ? `${payload.assignee} 于 ${nowText()} 完成 Omni 视频转存：${archived.publicUrl}；Flow 分享链接：${payload.shareUrl}`
      : payload.platform === "直链"
        ? `${payload.assignee} 于 ${nowText()} 完成浏览器视频直链转存：${archived.publicUrl}`
        : `${payload.assignee} 于 ${nowText()} 完成豆包无水印视频转存：${archived.publicUrl}；豆包分享链接：${payload.shareUrl}`;
    await updateRecord(payload.recordId, {
      [field(env, "STATUS", "任务状态")]: status(env, "DONE", "已完成"),
      [field(env, "COMPLETED_AT", "完成时间")]: Date.now(),
      [field(env, "VIDEO_URL", "视频地址")]: archived.publicUrl,
      [field(env, "LAST_ERROR", "最后错误")]: "",
      [field(env, "LOG", "接单日志")]: appendLog(fieldText(record.fields?.[field(env, "LOG", "接单日志")]), log),
    }, env);
    await finishJob(jobId, "completed", { videoUrl: archived.publicUrl, platform: payload.platform }, "R2 转存成功，已回填飞书并完成订单", "", env);
  } catch (error) {
    await finishJob(jobId, "failed", {}, "R2 转存失败，订单保持接单中，可重试或释放", publicError(error), env);
    const record = await getRecord(payload.recordId, env).catch(() => null);
    if (record && owns(record, payload.lockId, payload.assignee, env)) {
      await updateRecord(payload.recordId, {
        [field(env, "LAST_ERROR", "最后错误")]: publicError(error),
        [field(env, "LOG", "接单日志")]: appendLog(fieldText(record.fields?.[field(env, "LOG", "接单日志")]), `${payload.assignee} 于 ${nowText()} 转存失败：${publicError(error)}`),
      }, env).catch(() => {});
    }
    throw error;
  }
}

async function releaseBatch(body, env) {
  const assignee = text(body?.assignee);
  const items = Array.isArray(body?.orders)
    ? body.orders.slice(0, MAX_BATCH).map((item) => ({ recordId: text(item?.recordId), lockId: text(item?.lockId) })).filter((item) => item.recordId && item.lockId)
    : [];
  if (!items.length) throw new PublicError("没有可释放的订单", 400);
  const records = new Map((await batchGetRecords(items.map((item) => item.recordId), env)).map((record) => [record.record_id, record]));
  const results = [];
  const updates = [];
  for (const item of items) {
    try {
      const record = records.get(item.recordId);
      if (!record) throw new PublicError("飞书记录不存在", 404);
      assertLock(record, item.lockId, assignee, env);
      const running = await env.ORDER_DB.prepare("SELECT id FROM order_jobs WHERE record_id=? AND lock_id=? AND type='complete' AND status='processing' LIMIT 1").bind(item.recordId, item.lockId).first();
      if (running) throw new Error("视频正在转存，暂时不能释放");
      const fields = record.fields || {};
      const failCount = Number(fieldText(fields[field(env, "FAIL_COUNT", "失败次数")]) || 0) + 1;
      const garbage = failCount >= Number(env.MAX_FAIL_COUNT || 3);
      updates.push({
        record_id: item.recordId,
        fields: releaseFields(fields, assignee, failCount, garbage, "用户在网页批量工作台释放任务", env),
      });
      results.push({ recordId: item.recordId, ok: true });
    } catch (error) {
      results.push({ recordId: item.recordId, ok: false, error: publicError(error) });
    }
  }
  if (updates.length) await batchUpdateRecords(updates, env);
  return { ok: results.some((item) => item.ok), released: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length, results };
}

async function releaseOrder(body, env) {
  const recordId = text(body?.recordId);
  const lockId = text(body?.lockId);
  const assignee = text(body?.assignee);
  if (!recordId || !lockId) throw new PublicError("缺少 recordId 或 lockId", 400);
  const record = await getRecord(recordId, env);
  assertLock(record, lockId, assignee, env);
  const running = await env.ORDER_DB.prepare("SELECT id FROM order_jobs WHERE record_id=? AND lock_id=? AND type='complete' AND status='processing' LIMIT 1").bind(recordId, lockId).first();
  if (running) throw new Error("视频正在转存，暂时不能释放");
  const fields = record.fields || {};
  const failCount = Number(fieldText(fields[field(env, "FAIL_COUNT", "失败次数")]) || 0) + 1;
  const garbage = failCount >= Number(env.MAX_FAIL_COUNT || 3);
  await updateRecord(recordId, releaseFields(fields, assignee, failCount, garbage, text(body?.reason) || "用户释放任务", env), env);
  return { ok: true };
}

function releaseFields(fields, assignee, failCount, garbage, reason, env) {
  return {
    [field(env, "STATUS", "任务状态")]: garbage ? status(env, "GARBAGE", "垃圾任务") : status(env, "PENDING", "待接单"),
    [field(env, "ASSIGNEE", "接单人")]: null,
    [field(env, "CLAIMED_AT", "接单时间")]: null,
    [field(env, "LOCK_ID", "接单锁ID")]: null,
    [field(env, "PLATFORM", "制作平台")]: null,
    [field(env, "FAIL_COUNT", "失败次数")]: failCount,
    [field(env, "LOG", "接单日志")]: appendLog(fieldText(fields[field(env, "LOG", "接单日志")]), `${assignee || "接单人"} 于 ${nowText()} 释放任务：${reason}`),
  };
}

async function getStats(env) {
  const [pending, inProgress, done, garbage] = await Promise.all([
    countRecordsByStatus(status(env, "PENDING", "待接单"), env),
    countRecordsByStatus(status(env, "IN_PROGRESS", "接单中"), env),
    countRecordsByStatus(status(env, "DONE", "已完成"), env),
    countRecordsByStatus(status(env, "GARBAGE", "垃圾任务"), env),
  ]);
  const counts = { pending, inProgress, done, garbage, other: 0, total: pending + inProgress + done + garbage };
  return { counts };
}

async function countRecordsByStatus(value, env) {
  const token = await tenantToken(env);
  const url = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records`);
  url.searchParams.set("page_size", "1");
  url.searchParams.set("filter", `CurrentValue.[${field(env, "STATUS", "任务状态")}]="${escapeFilter(value)}"`);
  const data = await feishuJson(url, { headers: { Authorization: `Bearer ${token}` } });
  return Number(data.data?.total || 0);
}

async function prepareOrderFileUpload(body, env) {
  const recordId = text(body?.recordId), lockId = text(body?.lockId), assignee = text(body?.assignee);
  const fileName = sanitizeFileName(body?.fileName), fileSize = Number(body?.fileSize || 0), contentType = videoContentType(body?.contentType, fileName);
  const maxBytes = Number(env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
  if (!recordId || !lockId || !assignee) throw new PublicError("缺少 recordId、lockId 或接单人", 400);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > maxBytes) throw new PublicError(`视频文件大小无效或超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`, 400);
  assertLock(await getRecord(recordId, env), lockId, assignee, env);
  const now = Date.now(), ticket = crypto.randomUUID(), objectKey = objectKeyFor(recordId, fileName, env), publicUrl = publicR2Url(objectKey, env);
  await env.ORDER_DB.prepare(`INSERT INTO order_upload_tickets
    (ticket,record_id,lock_id,assignee,file_name,file_size,content_type,object_key,public_url,status,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(ticket, recordId, lockId, assignee, fileName, fileSize, contentType, objectKey, publicUrl, "prepared", now, now, now + UPLOAD_TTL_MS).run();
  return { ok: true, ticket, expiresAt: now + UPLOAD_TTL_MS, maxBytes, uploadPath: "/order-file-upload" };
}

export async function authorizeOrderFileUpload(body, env) {
  const ticket = await uploadTicket(body?.ticket, env);
  if (Number(body?.contentLength || 0) !== ticket.file_size) throw new PublicError("上传文件大小与申请信息不一致", 400);
  if (videoContentType(body?.contentType, ticket.file_name) !== ticket.content_type) throw new PublicError("上传文件类型与申请信息不一致", 400);
  assertLock(await getRecord(ticket.record_id, env), ticket.lock_id, ticket.assignee, env);
  await env.ORDER_DB.prepare("UPDATE order_upload_tickets SET status='uploading',updated_at=? WHERE ticket=?").bind(Date.now(), ticket.ticket).run();
  return { ok: true, objectKey: ticket.object_key, publicUrl: ticket.public_url, contentType: ticket.content_type, fileSize: ticket.file_size, fileName: ticket.file_name };
}

async function completeOrderFileUpload(body, env) {
  const ticket = await uploadTicket(body?.ticket, env);
  const object = await env.ORDER_VIDEOS.head(ticket.object_key);
  if (!object || Number(object.size) !== Number(ticket.file_size)) throw new Error("R2 视频尚未完整上传，请重新选择视频");
  const record = await getRecord(ticket.record_id, env);
  assertLock(record, ticket.lock_id, ticket.assignee, env);
  await updateRecord(ticket.record_id, {
    [field(env, "STATUS", "任务状态")]: status(env, "DONE", "已完成"),
    [field(env, "COMPLETED_AT", "完成时间")]: Date.now(),
    [field(env, "VIDEO_URL", "视频地址")]: ticket.public_url,
    [field(env, "LAST_ERROR", "最后错误")]: "",
    [field(env, "LOG", "接单日志")]: appendLog(fieldText(record.fields?.[field(env, "LOG", "接单日志")]), `${ticket.assignee} 于 ${nowText()} 使用视频文件直传完成回填：${ticket.public_url}；文件：${ticket.file_name}`),
  }, env);
  await env.ORDER_DB.prepare("UPDATE order_upload_tickets SET status='completed',updated_at=?,expires_at=? WHERE ticket=?").bind(Date.now(), Date.now() + 30 * 60 * 1000, ticket.ticket).run();
  return { ok: true, status: "completed", recordId: ticket.record_id, videoUrl: ticket.public_url };
}

async function streamVideoToR2(sourceUrl, context, env) {
  const response = await fetch(sourceUrl, { redirect: "follow", headers: { Accept: "video/mp4,video/*,*/*;q=0.8", "User-Agent": "Mozilla/5.0 (compatible; MAILAB-Cloudflare/1.0)" } });
  if (!response.ok || !response.body) throw new Error(`视频获取失败 HTTP ${response.status}`);
  const type = String(response.headers.get("Content-Type") || "").toLowerCase();
  if (/html|json|text/.test(type)) throw new Error(`视频地址返回非视频内容：${type}`);
  const size = Number(response.headers.get("Content-Length") || 0);
  if (size && size > Number(env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024)) throw new Error("视频超过 Cloudflare 直传限制");
  const key = objectKeyFor(context.recordId, sourceUrl, env);
  await env.ORDER_VIDEOS.put(key, response.body, { httpMetadata: { contentType: videoContentType(type, sourceUrl) }, customMetadata: { source: context.platform.toLowerCase(), recordId: context.recordId, uploadedAt: new Date().toISOString() } });
  const object = await env.ORDER_VIDEOS.head(key);
  if (!object) throw new Error("R2 没有确认视频对象");
  return { objectKey: key, publicUrl: publicR2Url(key, env) };
}

async function resolveDoubaoVideo(shareUrl, suppliedFallback) {
  let fallback = normalizeFallback(suppliedFallback);
  if (!fallback) {
    const page = await fetch(shareUrl, { headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; MAILAB-Cloudflare/1.0)" } });
    if (!page.ok) throw new Error(`豆包分享页请求失败 HTTP ${page.status}`);
    fallback = extractFallback(await page.text());
  }
  if (!fallback) throw new Error("豆包分享页没有返回视频数据");
  const infoUrl = new URL(fallback);
  infoUrl.searchParams.set("channel", "no"); infoUrl.searchParams.set("codec_type", "8"); infoUrl.searchParams.set("logo_type", "unwatermarked");
  const response = await fetch(infoUrl, { headers: { Accept: "application/json", Referer: "https://www.doubao.com/", "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`豆包视频信息请求失败 HTTP ${response.status}`);
  const payload = await response.json();
  const seed = findKeySeed(payload);
  const candidates = collectVideoTokens(payload);
  const rejected = new Set();
  for (const candidate of candidates) {
    const direct = await decodeVideoToken(candidate, seed);
    if (!direct) continue;
    const url = new URL(direct);
    if (!trustedVideoHost(url.hostname)) { rejected.add(url.hostname); continue; }
    if (url.searchParams.get("lr") && url.searchParams.get("lr") !== "unwatermarked") continue;
    return direct;
  }
  if (rejected.size) throw new Error(`豆包返回了非受信任的视频域名：${[...rejected].slice(0, 5).join("、")}`);
  throw new Error("豆包视频直链解析失败");
}

async function decodeVideoToken(value, keySeed) {
  const raw = text(value);
  if (isHttps(raw)) return raw;
  const plain = base64Bytes(raw);
  if (plain) {
    const decoded = new TextDecoder().decode(plain).trim();
    if (isHttps(decoded)) return decoded;
  }
  if (!raw.startsWith("qAAB") || !keySeed) return "";
  try {
    const encrypted = base64Bytes(raw), seed = base64Bytes(keySeed);
    if (!encrypted || !seed || encrypted.length < 20 || encrypted.length % 16 !== 4) return "";
    const first = new Uint8Array(await crypto.subtle.digest("SHA-512", seed));
    const salt = hexBytes(FPLAY_KDF_SALT_HEX);
    const combined = new Uint8Array(first.length + salt.length); combined.set(first); combined.set(salt, first.length);
    const derived = new Uint8Array(await crypto.subtle.digest("SHA-512", combined));
    const key = await crypto.subtle.importKey("raw", derived.slice(0, 16), { name: "AES-CBC" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: derived.slice(16, 32) }, key, encrypted.slice(4));
    const result = new TextDecoder().decode(decrypted).trim();
    return isHttps(result) ? result : "";
  } catch { return ""; }
}

async function proxyOrderImage(url) {
  const source = normalizeHttp(url.searchParams.get("url"));
  if (!source) return fail("图片地址无效", 400);
  const parsed = new URL(source);
  if (isPrivateHost(parsed.hostname)) return fail("图片地址不可访问", 403);
  const response = await fetch(source, { redirect: "follow", headers: { Accept: "image/*,*/*;q=0.8", "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) return fail(`图片读取失败 HTTP ${response.status}`, 502);
  const type = response.headers.get("Content-Type") || "application/octet-stream";
  if (!type.toLowerCase().startsWith("image/")) return fail("地址没有返回图片", 415);
  return new Response(response.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" } });
}

async function listPendingRecords(env) {
  try { return await listRecords(env, { viewId: env.FEISHU_PENDING_VIEW_ID }); }
  catch (error) {
    if (!isDataNotReady(error)) throw error;
    const all = await listRecords(env);
    return all.filter((record) => fieldText(record.fields?.[field(env, "STATUS", "任务状态")]) === status(env, "PENDING", "待接单"));
  }
}

async function listRecords(env, { viewId = "", filter = "" } = {}) {
  const token = await tenantToken(env), records = [];
  let pageToken = "";
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records`);
    url.searchParams.set("page_size", "500");
    if (viewId) url.searchParams.set("view_id", viewId);
    if (filter) url.searchParams.set("filter", filter);
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await feishuJson(url, { headers: { Authorization: `Bearer ${token}` } });
    records.push(...(data.data?.items || []));
    if (!data.data?.has_more || !data.data?.page_token) return records;
    pageToken = data.data.page_token;
  }
  throw new Error("飞书记录分页超过限制");
}

async function getRecord(recordId, env) {
  const token = await tenantToken(env);
  const data = await feishuJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/${encodeURIComponent(recordId)}`, { headers: { Authorization: `Bearer ${token}` } });
  return data.data?.record || data.data;
}

async function batchGetRecords(recordIds, env) {
  const token = await tenantToken(env);
  const data = await feishuJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/batch_get`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ record_ids: [...new Set(recordIds)] }),
  });
  return data.data?.records || data.data?.items || [];
}

async function updateRecord(recordId, fields, env) {
  const token = await tenantToken(env);
  const data = await feishuJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/${encodeURIComponent(recordId)}`, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }),
  });
  return data.data?.record || data.data;
}

async function batchUpdateRecords(records, env) {
  const token = await tenantToken(env);
  const data = await feishuJson(`https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${env.FEISHU_TABLE_ID}/records/batch_update`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ records }),
  });
  return data.data?.records || [];
}

async function tenantToken(env) {
  requireBindings(env);
  if (tokenCache.token && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }) });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error(data.msg || "获取飞书 token 失败");
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + Math.max(60, Number(data.expire || 7200) - 300) * 1000 };
  return tokenCache.token;
}

async function feishuJson(input, options = {}) {
  let last;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(input, options), data = await response.json();
      if (response.ok && data.code === 0) return data;
      last = new Error(data.msg || `飞书接口 HTTP ${response.status}`);
      if (!(response.status === 429 || response.status >= 500 || isDataNotReady(last))) throw last;
    } catch (error) { last = error; }
    await delay(Math.min(3000, 300 * (attempt + 1)));
  }
  throw last || new Error("飞书接口暂时不可用");
}

async function getJob(id, expectedType, env) {
  const row = await jobRow(text(id), env);
  if (!row || (expectedType && row.type !== expectedType)) return { ok: false, status: "missing", error: "后台任务不存在或已过期" };
  return publicJob(row);
}

async function jobRow(id, env) { return id ? env.ORDER_DB.prepare("SELECT * FROM order_jobs WHERE id=?").bind(id).first() : null; }

function publicJob(row) {
  const result = parseJson(row.result);
  return {
    ok: row.status !== "failed", accepted: true, jobId: row.id, status: row.status,
    assignee: row.assignee, recordId: row.record_id, requested: result.requested || parseJson(row.payload).requested || 0,
    claimed: result.claimed || 0, partial: Boolean(result.partial), orders: result.orders || [], platform: result.platform || parseJson(row.payload).platform || "",
    videoUrl: result.videoUrl || "", error: row.error || result.error || "", message: row.message,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: ["completed", "failed"].includes(row.status) ? row.updated_at : "",
  };
}

async function updateJobProgress(id, claimed, requested, env) {
  await env.ORDER_DB.prepare("UPDATE order_jobs SET result=?,message=?,updated_at=? WHERE id=?").bind(JSON.stringify({ claimed, requested }), `后台正在接单：已确认 ${claimed}/${requested} 单`, Date.now(), id).run();
}
async function setJobMessage(id, message, env) { await env.ORDER_DB.prepare("UPDATE order_jobs SET message=?,updated_at=? WHERE id=?").bind(message, Date.now(), id).run(); }
async function finishJob(id, statusValue, result, message, error, env) { await env.ORDER_DB.prepare("UPDATE order_jobs SET status=?,result=?,message=?,error=?,updated_at=? WHERE id=?").bind(statusValue, JSON.stringify(result || {}), message || "", error || "", Date.now(), id).run(); }

async function uploadTicket(value, env) {
  const ticket = text(value);
  const row = ticket ? await env.ORDER_DB.prepare("SELECT * FROM order_upload_tickets WHERE ticket=?").bind(ticket).first() : null;
  if (!row || Number(row.expires_at) <= Date.now()) throw new PublicError("上传票据不存在或已过期，请重新选择视频", 400);
  return row;
}

function buildOrder(record, assignee, rowNumber, env) {
  const fields = record.fields || {};
  return {
    ok: true, recordId: record.record_id, lockId: fieldText(fields[field(env, "LOCK_ID", "接单锁ID")]), assignee,
    prompt: fieldText(fields[field(env, "PROMPT", "提示词")]), imageUrl: fieldText(fields[field(env, "IMAGE_URL", "图片地址")]),
    rowNumber: rowNumber || 0, platform: fieldText(fields[field(env, "PLATFORM", "制作平台")]),
    status: fieldText(fields[field(env, "STATUS", "任务状态")]), claimedAt: fieldText(fields[field(env, "CLAIMED_AT", "接单时间")]),
    shareUrl: fieldText(fields[field(env, "WATERMARK_URL", "去水印原始链接")]), videoUrl: fieldText(fields[field(env, "VIDEO_URL", "视频地址")]),
  };
}

function owns(record, lockId, assignee, env) {
  const fields = record.fields || {};
  return fieldText(fields[field(env, "LOCK_ID", "接单锁ID")]) === lockId
    && fieldText(fields[field(env, "ASSIGNEE", "接单人")]) === assignee
    && [status(env, "IN_PROGRESS", "接单中"), status(env, "DONE", "已完成")].includes(fieldText(fields[field(env, "STATUS", "任务状态")]));
}
function assertLock(record, lockId, assignee, env) {
  const fields = record.fields || {};
  const matches = fieldText(fields[field(env, "LOCK_ID", "接单锁ID")]) === lockId
    && (!assignee || fieldText(fields[field(env, "ASSIGNEE", "接单人")]) === assignee)
    && fieldText(fields[field(env, "STATUS", "任务状态")]) === status(env, "IN_PROGRESS", "接单中");
  if (!matches) throw new PublicError("接单锁、接单人或任务状态不匹配", 409);
}
function field(env, suffix, fallback) { return env[`FIELD_${suffix}`] || fallback; }
function status(env, suffix, fallback) { return env[`STATUS_${suffix}`] || fallback; }
function requireBindings(env) { if (!env.ORDER_DB || !env.ORDER_JOBS || !env.ORDER_VIDEOS || !env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_APP_TOKEN || !env.FEISHU_TABLE_ID) throw new Error("Cloudflare 接单服务配置不完整"); }

function normalizeFlow(value) { try { const url = new URL(text(value)); const match = url.pathname.match(FLOW_PATH); return url.protocol === "https:" && ["labs.google", "flow.google.com"].includes(url.hostname) && match ? `https://labs.google/fx/tools/flow/shared/video/${match[1].toLowerCase()}` : ""; } catch { return ""; } }
function flowSource(value) { const url = normalizeFlow(value), match = url && new URL(url).pathname.match(FLOW_PATH); if (!match) throw new Error("Flow 分享链接无效"); return `https://labs.google/fx/api/og-video/shared/${match[1].toLowerCase()}`; }
function normalizeDoubao(value) { try { const url = new URL(text(value)); return url.protocol === "https:" && url.hostname === "www.doubao.com" && /^\/thread\/[^/]+\/?$/.test(url.pathname) ? `${url.origin}${url.pathname.replace(/\/$/, "")}` : ""; } catch { return ""; } }
function normalizeFallback(value) { try { const url = new URL(text(value)); return url.protocol === "https:" && (url.hostname === "snssdk.com" || url.hostname.endsWith(".snssdk.com")) && url.pathname.includes("/video/fplay/") ? url.toString() : ""; } catch { return ""; } }
function extractFallback(html) { const part = text(html).slice(Math.max(0, text(html).indexOf("fallback_api") - 1000), text(html).indexOf("fallback_api") + 8000).replace(/&amp;|&#38;|&#x26;/gi, "&").replace(/\\u0026/gi, "&").replace(/\\u002f/gi, "/").replace(/\\\//g, "/"); return (part.match(/https:\/\/[^\s"'<>\\]+/g) || []).map(normalizeFallback).find(Boolean) || ""; }
function collectVideoTokens(value, depth = 0, out = []) { if (depth > 12 || value == null) return out; if (typeof value === "string" && (value.startsWith("https://") || value.startsWith("qAAB"))) out.push(value); else if (typeof value === "object") for (const child of Object.values(value)) collectVideoTokens(child, depth + 1, out); return [...new Set(out)]; }
function findKeySeed(value, depth = 0) { if (depth > 12 || value == null) return ""; if (typeof value === "string") { const match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i); return match ? decodeURIComponent(match[1]) : ""; } if (typeof value === "object") { if (typeof value.key_seed === "string") return value.key_seed; for (const child of Object.values(value)) { const found = findKeySeed(child, depth + 1); if (found) return found; } } return ""; }
function trustedVideoHost(host) { return TRUSTED_VIDEO_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)); }
function isHttps(value) { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }
function base64Bytes(value) { try { const normalized = text(value).replace(/[$]/g, "_").replace(/[@]/g, "/").replace(/[#]/g, "=").replace(/-/g, "+").replace(/_/g, "/"); const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); } catch { return null; } }
function hexBytes(value) { return Uint8Array.from(value.match(/../g).map((item) => Number.parseInt(item, 16))); }
function normalizeRows(value) { if (!Array.isArray(value)) return []; const rows = [...new Set(value.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0))]; if (rows.length > MAX_BATCH) throw new PublicError(`一次最多指定 ${MAX_BATCH} 个行号`, 400); return rows; }
function sanitizeRequestId(value) { const id = text(value); if (id && !/^[a-zA-Z0-9._:-]{8,128}$/.test(id)) throw new PublicError("批量接单请求编号无效", 400); return id; }
function sanitizeFileName(value) { const name = text(value || "video.mp4").split(/[\\/]/).pop().replace(/[^\w.\-()\u4e00-\u9fa5 ]+/g, "_").slice(0, 120); if (!/\.(mp4|mov|webm|m4v)$/i.test(name)) throw new PublicError("只支持 MP4、MOV、WebM 或 M4V 视频文件", 400); return name; }
function videoContentType(value, name) { const input = text(value).split(";")[0].toLowerCase(); if (input && !["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "application/octet-stream"].includes(input)) throw new PublicError("只支持视频文件上传", 400); const ext = extension(name); return input && input !== "application/octet-stream" ? input : (ext === ".mov" ? "video/quicktime" : ext === ".webm" ? "video/webm" : ext === ".m4v" ? "video/x-m4v" : "video/mp4"); }
function extension(value) { try { return extension(new URL(value).pathname); } catch { return text(value).toLowerCase().match(/\.(mp4|mov|webm|m4v)(?:$|[?#])/)?.[1] ? `.${text(value).toLowerCase().match(/\.(mp4|mov|webm|m4v)(?:$|[?#])/)?.[1]}` : ".mp4"; } }
function objectKeyFor(recordId, source, env) { const date = new Date(), prefix = text(env.R2_PREFIX || "mailab/videos").replace(/^\/+|\/+$/g, ""); return `${prefix}/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${slug(recordId)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}${extension(source)}`; }
function publicR2Url(key, env) { const base = text(env.R2_PUBLIC_BASE_URL).replace(/\/+$/, ""); if (!base) throw new Error("缺少 R2_PUBLIC_BASE_URL"); return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`; }
function normalizeHttp(value) { try { const url = new URL(text(value)); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : ""; } catch { return ""; } }
function normalizePublicHttps(value) { try { const url = new URL(text(value)); return url.protocol === "https:" && !url.username && !url.password && !isPrivateHost(url.hostname) ? url.toString() : ""; } catch { return ""; } }
function isPrivateHost(host) { return host === "localhost" || host === "127.0.0.1" || host === "::1" || /^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host); }
function fieldText(value) { if (value == null) return ""; if (["string", "number", "boolean"].includes(typeof value)) return String(value); if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(""); if (typeof value === "object") return fieldText(value.text ?? value.name ?? value.link ?? value.url ?? ""); return String(value); }
function extractRow(value) { const matches = [...text(value).matchAll(/(?:待接单视图|兼职表)第\s*(\d+)\s*行/g)]; return Number(matches.at(-1)?.[1] || 0); }
function appendLog(previous, line) { return [text(previous), line].filter(Boolean).join("\n"); }
function escapeFilter(value) { return text(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function slug(value) { return text(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "record"; }
function text(value) { return String(value ?? "").trim(); }
function parseJson(value) { try { return JSON.parse(value || "{}"); } catch { return {}; } }
function nowText() { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date()).replaceAll("/", "-"); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function mask(value) { const input = text(value); return input ? `${input.slice(0, 4)}...${input.slice(-4)}` : ""; }
function isDataNotReady(error) { return /data not ready|数据尚未准备好/i.test(publicError(error)); }
function isRetryable(error) { return /timeout|network|fetch failed|429|500|502|503|504|暂时|超时/i.test(publicError(error)); }
function publicError(error) { return String(error?.message || error || "服务异常").replace(/<!doctype[\s\S]*/i, "服务返回异常，请稍后重试").slice(0, 500); }
function statusForError(error) { return error instanceof PublicError ? error.status : 500; }
function ok(data) { return Response.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } }); }
function fail(error, statusCode = 500) { return Response.json({ ok: false, error }, { status: statusCode, headers: { "Cache-Control": "no-store" } }); }

class PublicError extends Error { constructor(message, statusCode = 400) { super(message); this.status = statusCode; } }

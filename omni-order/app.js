const RESOLVER = "https://tuchuang-api.yeadon8888.workers.dev";
const API_ROUTES = [
  { base: "https://genvideo.mailab.top", label: "源站直连" },
  { base: `${RESOLVER}/order-api`, label: "Cloudflare" },
];
let API = API_ROUTES[0].base;
let apiRouteLabel = API_ROUTES[0].label;
const FLOW_PATH = /^\/fx\/tools\/flow\/shared\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i;
const DOUBAO_PATH = /^\/thread\/[^/?#]+\/?$/i;
const STATE_KEY = "mailab_multi_platform_workbench_v2";
const LEGACY_STATE_KEY = "mailab_omni_batch_workbench_v1";
const BATCH_SIZE_OPTIONS = [10, 30, 50, 100];
const DEFAULT_BATCH_SIZE = 10;
const MAX_ACTIVE_ORDERS = 100;

const platformMeta = {
  Omni: { slug: "omni", input: "Flow 单视频公开分享链接", open: "打开 Flow", url: "https://labs.google/fx/tools/flow" },
  豆包: { slug: "doubao", input: "豆包视频公开分享链接", open: "打开豆包", url: "https://www.doubao.com/chat/" },
  "": { slug: "unknown", input: "Omni 或豆包视频分享链接", open: "打开制作平台", url: "#" },
};

const statusMeta = {
  claimed: { label: "待制作", message: "等待填写视频分享链接" },
  submitting: { label: "识别中", message: "正在识别链接并创建转存任务" },
  processing: { label: "转存中", message: "正在获取视频并转存 R2" },
  completed: { label: "已完成", message: "R2 已验证并完成飞书回填" },
  error: { label: "可重试", message: "处理失败，订单仍保持接单中" },
  lost: { label: "已失效", message: "订单锁已变化或任务已被释放" },
};

const els = {
  serverState: document.getElementById("server-state"),
  serverStateText: document.getElementById("server-state-text"),
  claimForm: document.getElementById("claim-form"),
  assignee: document.getElementById("assignee-input"),
  rowNumbers: document.getElementById("row-numbers-input"),
  quantity: document.getElementById("quantity-input"),
  claim: document.getElementById("claim-button"),
  recover: document.getElementById("recover-button"),
  submitAll: document.getElementById("submit-all-button"),
  releaseAll: document.getElementById("release-all-button"),
  clearCompleted: document.getElementById("clear-completed-button"),
  deckMessage: document.getElementById("deck-message"),
  metricActive: document.getElementById("metric-active"),
  metricProcessing: document.getElementById("metric-processing"),
  metricCompleted: document.getElementById("metric-completed"),
  empty: document.getElementById("empty-state"),
  grid: document.getElementById("orders-grid"),
  template: document.getElementById("order-template"),
  toast: document.getElementById("toast"),
};

let state = loadState();
let serverOnline = false;
let claimBusy = false;
let batchBusy = false;
let toastTimer = 0;
const pollers = new Map();

bootstrap();

function bootstrap() {
  els.assignee.value = state.assignee;
  els.quantity.value = String(state.quantity);
  bindEvents();
  render();
  checkHealth();
  if (state.claimJobId) {
    claimBusy = true;
    pollClaimBatch(state.claimJobId, Boolean(state.claimRowNumbers.length))
      .catch(() => recoverOrders(true))
      .finally(() => {
        claimBusy = false;
        renderControls();
      });
  } else if (state.assignee) {
    recoverOrders(true);
  }
}

function bindEvents() {
  els.claimForm.addEventListener("submit", claimBatch);
  els.assignee.addEventListener("change", () => {
    state.assignee = els.assignee.value.trim();
    saveState();
  });
  els.quantity.addEventListener("change", () => {
    state.quantity = normalizeBatchSize(els.quantity.value);
    saveState();
  });
  els.rowNumbers.addEventListener("input", renderControls);
  els.recover.addEventListener("click", () => recoverOrders(false));
  els.submitAll.addEventListener("click", submitAllReady);
  els.releaseAll.addEventListener("click", releaseAllUnsubmitted);
  els.clearCompleted.addEventListener("click", clearFinishedCards);
  els.grid.addEventListener("input", handleGridInput);
  els.grid.addEventListener("click", handleGridClick);
}

async function checkHealth() {
  try {
    const route = await Promise.any(API_ROUTES.map(probeApiRoute));
    API = route.base;
    apiRouteLabel = route.label;
    serverOnline = true;
    els.serverState.className = "server-state online";
    els.serverStateText.textContent = `后端在线 · ${apiRouteLabel} · 飞书与 R2 已连接`;
  } catch (error) {
    serverOnline = false;
    els.serverState.className = "server-state offline";
    els.serverStateText.textContent = "直连与 Cloudflare 均无法连接";
  }
  renderControls();
}

async function probeApiRoute(route) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const startedAt = performance.now();
    const response = await fetch(`${route.base}/api/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await response.json();
    const features = Array.isArray(data.features) ? data.features : [];
    if (!response.ok || !data.ok || !features.includes("multi-platform-order-web")) {
      throw new Error("后端尚未部署多平台接单功能");
    }
    return { ...route, latency: performance.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

async function claimBatch(event) {
  event.preventDefault();
  if (claimBusy) return;
  const assignee = els.assignee.value.trim();
  let rowNumbers;
  try { rowNumbers = parseRowNumbers(els.rowNumbers.value); }
  catch (error) { return setDeck(error.message, "error"); }
  const targeted = rowNumbers.length > 0;
  const count = targeted ? rowNumbers.length : normalizeBatchSize(els.quantity.value);
  const activeCount = activeOrders().length;
  if (!assignee) return setDeck("请先填写接单人。", "error");
  if (activeCount + count > MAX_ACTIVE_ORDERS) {
    return setDeck(`当前已持有 ${activeCount} 单，本次最多还能领取 ${MAX_ACTIVE_ORDERS - activeCount} 单。`, "error");
  }
  state.assignee = assignee;
  if (!targeted) state.quantity = count;
  state.claimRequestId = createRequestId();
  state.claimCount = count;
  state.claimRowNumbers = rowNumbers;
  state.claimJobId = "";
  saveState();
  claimBusy = true;
  setDeck(targeted ? `正在领取待接单视图第 ${rowNumbers.join("、")} 行…` : `正在从公共任务池领取 ${count} 个订单…`, "warn");
  renderControls();
  try {
    const data = await api("/api/order/claim-batch/start", {
      assignee,
      count,
      clientRequestId: state.claimRequestId,
      ...(targeted ? { rowNumbers } : {}),
    }, 15000);
    if (!data.accepted || !data.jobId) throw new Error(data.error || "批量接单任务创建失败");
    state.claimJobId = data.jobId;
    saveState();
    await pollClaimBatch(data.jobId, targeted);
  } catch (error) {
    setDeck(`${error.message || "批量接单失败"}；正在按接单人检查是否已成功领取…`, "warn");
    await delay(800);
    await recoverOrders(true);
  } finally {
    claimBusy = false;
    renderControls();
  }
}

async function pollClaimBatch(jobId, targeted = false) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    const data = await api("/api/order/claim-batch/status", { jobId }, 15000);
    if (data.status === "processing") {
      setDeck(`后台正在接单：已确认 ${data.claimed || 0}/${data.requested || state.claimCount || 0} 单…`, "warn");
      await delay(1000);
      continue;
    }
    if (data.status === "failed") throw new Error(data.error || data.message || "批量接单失败");
    const added = mergeRecoveredOrders(data.orders || [], false);
    clearPendingClaim();
    if (targeted) els.rowNumbers.value = "";
    saveState();
    render();
    const suffix = data.partial ? `；其余未领取：${data.error || "任务不足"}` : "";
    setDeck(`${targeted ? "指定行号" : "批量"}成功领取 ${data.claimed || added} 单${suffix}`, data.partial ? "warn" : "success");
    showToast(`已加入 ${added} 张制作卡片`);
    return;
  }
  throw new Error("后台接单仍在进行，可稍后点击“校验并恢复”");
}

async function recoverOrders(silent = false) {
  const candidates = activeOrders().map(({ recordId, lockId }) => ({ recordId, lockId }));
  if (!state.assignee) {
    if (!silent) setDeck("没有接单人信息，无法恢复订单。", "error");
    return;
  }
  if (!silent) setDeck("正在按接单人扫描飞书中的活动订单…", "warn");
  try {
    const [assigneeResult, localResult] = await Promise.allSettled([
      api("/api/order/recover-by-assignee", { assignee: state.assignee, limit: MAX_ACTIVE_ORDERS }, 60000),
      candidates.length
        ? api("/api/order/recover", { assignee: state.assignee, orders: candidates }, 60000)
        : Promise.resolve({ ok: true, orders: [] }),
    ]);
    const assigneeData = assigneeResult.status === "fulfilled" && assigneeResult.value.ok ? assigneeResult.value : null;
    const localData = localResult.status === "fulfilled" && localResult.value.ok ? localResult.value : null;
    if (!assigneeData && !localData) {
      throw new Error(assigneeResult.reason?.message || localResult.reason?.message || "恢复失败");
    }
    const recoveredById = new Map();
    for (const order of [...(assigneeData?.orders || []), ...(localData?.orders || [])]) {
      if (order.recordId) recoveredById.set(order.recordId, order);
    }
    mergeRecoveredOrders([...recoveredById.values()], Boolean(localData));
    clearPendingClaim();
    saveState();
    render();
    startPendingPollers();
    if (!silent) setDeck(`恢复完成：${recoveredById.size} 个有效订单。`, "success");
  } catch (error) {
    if (!silent) setDeck(error.message || "恢复订单失败", "error");
  }
}

function mergeRecoveredOrders(recoveredOrders, markMissing) {
  const recoveredById = new Map(recoveredOrders.map((order) => [order.recordId, order]));
  const existingIds = new Set(state.orders.map((order) => order.recordId));
  state.orders = state.orders.map((local) => {
    if (["completed", "lost"].includes(local.state)) return local;
    const recovered = recoveredById.get(local.recordId);
    if (!recovered) {
      return markMissing ? normalizeOrder({ ...local, state: "lost", jobId: "", message: "订单锁已经失效或已被释放" }) : local;
    }
    const next = normalizeOrder({
      ...local,
      ...recovered,
      platform: recovered.platform || local.platform || "",
      shareUrl: local.shareUrl || recovered.shareUrl || recovered.flowShareUrl || "",
      resultUrl: recovered.videoUrl || local.resultUrl || "",
      message: recovered.message || "订单已恢复",
    });
    if (recovered.state === "claimed" && local.state === "processing") {
      next.state = "error";
      next.jobId = "";
      next.message = "后台任务已结束或服务重启，可使用原链接重新提交";
    }
    return next;
  });
  const added = recoveredOrders
    .filter((order) => order.recordId && order.lockId && !existingIds.has(order.recordId))
    .map((order) => normalizeOrder({ ...order, state: order.state || "claimed", message: order.message || "已按接单人恢复", createdAt: Date.now() }));
  state.orders.push(...added);
  return added.length;
}

function clearPendingClaim() {
  state.claimJobId = "";
  state.claimRequestId = "";
  state.claimCount = 0;
  state.claimRowNumbers = [];
}

function handleGridInput(event) {
  if (event.target.dataset.action !== "share-input") return;
  const order = findOrder(event.target.closest("[data-record-id]")?.dataset.recordId);
  if (!order || ["processing", "submitting", "completed", "lost"].includes(order.state)) return;
  order.shareUrl = event.target.value.trim();
  const detected = detectPlatform(order.shareUrl);
  order.platform = detected.platform;
  order.message = detected.platform ? `已识别为 ${detected.platform} 链接，可以提交` : "等待识别 Omni 或豆包分享链接";
  saveState();
  renderCardIdentity(event.target.closest("[data-record-id]"), order);
  renderControls();
}

function handleGridClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button || button.dataset.action === "share-input") return;
  const order = findOrder(button.closest("[data-record-id]")?.dataset.recordId);
  if (!order) return;
  const action = button.dataset.action;
  if (action === "submit") submitOrder(order.recordId);
  else if (action === "release") releaseOrder(order.recordId);
  else if (action === "copy-prompt") copyText(order.prompt, "提示词已复制");
  else if (action === "copy-image") copyImage(order);
  else if (action === "copy-id") copyText(order.recordId, "任务 ID 已复制");
  else if (action === "open-platform") {
    const platform = order.platform || "Omni";
    window.open(platformMeta[platform].url, "_blank", "noopener,noreferrer");
  }
}

async function submitOrder(recordId) {
  const order = findOrder(recordId);
  if (!order || ["submitting", "processing", "completed", "lost"].includes(order.state)) return;
  const detected = detectPlatform(order.shareUrl);
  if (!detected.platform) {
    order.state = "error";
    order.message = "无法识别链接，请粘贴有效的 Omni Flow 或豆包公开分享链接";
    saveState();
    updateOrderCard(recordId);
    return;
  }
  const duplicate = state.orders.find((item) => {
    const other = detectPlatform(item.shareUrl);
    return item.recordId !== recordId && item.state !== "lost" && other.platform === detected.platform && other.url === detected.url;
  });
  if (duplicate) {
    order.state = "error";
    order.message = `该视频已填写在 ${shortId(duplicate.recordId)}，请检查对应关系`;
    saveState();
    updateOrderCard(recordId);
    return;
  }

  order.platform = detected.platform;
  order.shareUrl = detected.url;
  order.state = "submitting";
  order.message = detected.platform === "豆包" ? "正在读取豆包公开分享页" : "正在绑定 Flow 分享链接";
  saveState();
  updateOrderCard(recordId);
  try {
    const fallbackApi = detected.platform === "豆包" ? await resolveDoubaoFallback(detected.url) : "";
    const data = await api("/api/order/complete", {
      recordId: order.recordId,
      lockId: order.lockId,
      assignee: state.assignee || order.assignee,
      shareUrl: detected.url,
      ...(fallbackApi ? { fallbackApi } : {}),
    }, 45000);
    if (!data.ok || !data.jobId) throw new Error(data.error || "转存任务创建失败");
    order.platform = data.platform || detected.platform;
    order.state = "processing";
    order.jobId = data.jobId;
    order.message = data.message || "正在转存 R2";
    saveState();
    updateOrderCard(recordId);
    pollOrder(order.recordId);
  } catch (error) {
    order.state = "error";
    order.jobId = "";
    order.message = error.message || "提交失败，订单仍保持接单中";
    saveState();
    updateOrderCard(recordId);
  }
}

async function resolveDoubaoFallback(shareUrl) {
  const endpoint = new URL("/resolve/doubao-thread", RESOLVER);
  endpoint.searchParams.set("url", shareUrl);
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    return response.ok && data.fallbackApi ? data.fallbackApi : "";
  } catch {
    return "";
  }
}

async function pollOrder(recordId) {
  const order = findOrder(recordId);
  if (!order?.jobId || pollers.has(recordId)) return;
  const jobId = order.jobId;
  pollers.set(recordId, jobId);
  let networkErrors = 0;
  try {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const current = findOrder(recordId);
      if (!current || current.jobId !== jobId || current.state !== "processing") return;
      try {
        const data = await api("/api/order/complete-status", { jobId, platform: current.platform }, 20000);
        networkErrors = 0;
        if (data.status === "completed") {
          Object.assign(current, { state: "completed", jobId: "", resultUrl: data.videoUrl || "", message: "R2 已验证，飞书订单已完成", completedAt: Date.now() });
          saveState(); updateOrderCard(recordId); showToast(`${shortId(recordId)} 已完成回填`); return;
        }
        if (data.status === "failed" || data.status === "missing" || data.ok === false) {
          Object.assign(current, { state: "error", jobId: "", message: data.error || data.message || "转存失败，可使用原链接重试" });
          saveState(); updateOrderCard(recordId); return;
        }
        current.message = data.message || "正在转存 R2";
        saveState(); updateOrderCard(recordId);
      } catch (error) {
        networkErrors += 1;
        current.message = networkErrors >= 3 ? "网络暂时不稳定，仍在自动查询后台状态" : (error.message || "状态查询失败，正在重试");
        saveState(); updateOrderCard(recordId);
      }
      await delay(networkErrors ? 4000 : 2000);
    }
  } finally { pollers.delete(recordId); }
}

async function submitAllReady() {
  if (batchBusy) return;
  const candidates = state.orders.filter((order) => ["claimed", "error"].includes(order.state) && detectPlatform(order.shareUrl).platform);
  if (!candidates.length) return setDeck("没有可提交的有效链接；请先检查每张卡片。", "warn");
  batchBusy = true;
  setDeck(`正在提交 ${candidates.length} 个转存任务…`, "warn");
  renderControls();
  await runPool(candidates, 3, (order) => submitOrder(order.recordId));
  batchBusy = false;
  setDeck(`${candidates.length} 个任务已提交，结果会分别显示在卡片中。`, "success");
  renderControls();
}

async function releaseOrder(recordId) {
  const order = findOrder(recordId);
  if (!order || !["claimed", "error"].includes(order.state)) return;
  if (!window.confirm(`确认释放订单 ${shortId(recordId)}？释放后会回到公共任务池。`)) return;
  order.message = "正在释放订单"; saveState(); render();
  try {
    const data = await api("/api/release", {
      recordId: order.recordId,
      lockId: order.lockId,
      assignee: state.assignee || order.assignee,
      platform: order.platform,
      reason: "用户在多平台网页工作台释放任务",
    });
    if (!data.ok) throw new Error(data.error || "释放失败");
    state.orders = state.orders.filter((item) => item.recordId !== recordId);
    saveState(); render(); showToast(`${shortId(recordId)} 已释放`);
  } catch (error) {
    order.state = "error"; order.message = error.message || "释放失败"; saveState(); render();
  }
}

async function releaseAllUnsubmitted() {
  if (batchBusy) return;
  const candidates = state.orders.filter((order) => ["claimed", "error"].includes(order.state));
  if (!candidates.length) return setDeck("没有可批量释放的未转存订单。", "warn");
  if (!window.confirm(`确认释放 ${candidates.length} 个未转存订单？`)) return;
  batchBusy = true; setDeck(`正在释放 ${candidates.length} 个订单…`, "warn"); renderControls();
  try {
    const data = await api("/api/order/release-batch", {
      assignee: state.assignee,
      orders: candidates.map(({ recordId, lockId }) => ({ recordId, lockId })),
    }, 60000);
    const results = new Map((data.results || []).map((result) => [result.recordId, result]));
    state.orders = state.orders.filter((order) => {
      const result = results.get(order.recordId);
      if (result?.ok) return false;
      if (result && !result.ok) { order.state = "error"; order.message = result.error || "释放失败"; }
      return true;
    });
    saveState(); render();
    setDeck(`已释放 ${data.released || 0} 单${data.failed ? `，${data.failed} 单释放失败` : ""}。`, data.failed ? "warn" : "success");
  } catch (error) { setDeck(error.message || "批量释放失败", "error"); }
  finally { batchBusy = false; renderControls(); }
}

function clearFinishedCards() {
  const before = state.orders.length;
  state.orders = state.orders.filter((order) => !["completed", "lost"].includes(order.state));
  const removed = before - state.orders.length;
  if (!removed) return setDeck("当前没有可清理的已完成或失效卡片。", "warn");
  saveState(); render(); setDeck(`已清理 ${removed} 张历史卡片。`, "success");
}

function render() {
  const fragment = document.createDocumentFragment();
  state.orders.forEach((order, index) => fragment.appendChild(renderOrder(order, index)));
  els.grid.replaceChildren(fragment);
  els.empty.classList.toggle("hidden", state.orders.length > 0);
  renderMetrics();
  renderControls();
}

function renderOrder(order, index) {
  const article = els.template.content.firstElementChild.cloneNode(true);
  article.dataset.recordId = order.recordId;
  article.style.animationDelay = `${Math.min(index * 45, 360)}ms`;
  article.querySelector(".card-sequence").textContent = `ORDER ${pad(index + 1)}${order.rowNumber ? ` · 飞书行 ${order.rowNumber}` : ""}`;
  const recordButton = article.querySelector(".record-id");
  recordButton.textContent = order.recordId;
  recordButton.title = `复制任务 ID：${order.recordId}`;

  const frame = article.querySelector(".image-frame");
  const image = frame.querySelector("img");
  if (order.imageUrl) {
    frame.classList.add("has-image"); frame.href = order.imageUrl; image.src = imageProxyUrl(order.imageUrl, true);
  } else { frame.removeAttribute("href"); image.removeAttribute("src"); }
  article.querySelector("textarea").value = order.prompt || "当前任务没有提示词";

  syncOrderCard(article, order);
  article.querySelector('[data-action="copy-prompt"]').disabled = !order.prompt;
  article.querySelector('[data-action="copy-image"]').disabled = !order.imageUrl;
  return article;
}

function updateOrderCard(recordId) {
  const order = findOrder(recordId);
  const article = Array.from(els.grid.children).find((card) => card.dataset.recordId === recordId);
  if (!order || !article) return render();
  syncOrderCard(article, order);
  renderMetrics();
  renderControls();
}

function syncOrderCard(article, order) {
  const status = statusMeta[order.state] || statusMeta.claimed;
  article.dataset.state = order.state;
  renderCardIdentity(article, order);
  article.querySelector(".status-chip").textContent = status.label;
  article.querySelector(".job-message").textContent = order.message || status.message;
  article.querySelector(".job-percent").textContent = order.state === "processing" ? "R2" : (order.state === "completed" ? "100%" : "");

  const input = article.querySelector('[data-action="share-input"]');
  if (document.activeElement !== input) input.value = order.shareUrl || "";
  input.disabled = ["submitting", "processing", "completed", "lost"].includes(order.state);

  const result = article.querySelector(".result-link");
  result.classList.toggle("hidden", !order.resultUrl);
  if (order.resultUrl) result.href = order.resultUrl;
  else result.removeAttribute("href");

  const submit = article.querySelector('[data-action="submit"]');
  submit.disabled = ["submitting", "processing", "completed", "lost"].includes(order.state);
  submit.textContent = order.state === "error" ? "重新转存并回填" : (order.state === "completed" ? "已完成" : "转存并回填");
  article.querySelector('[data-action="release"]').disabled = !["claimed", "error"].includes(order.state);
}

function renderMetrics() {
  els.metricActive.textContent = pad(activeOrders().length);
  els.metricProcessing.textContent = pad(state.orders.filter((order) => ["submitting", "processing"].includes(order.state)).length);
  els.metricCompleted.textContent = pad(state.orders.filter((order) => order.state === "completed").length);
}

function renderCardIdentity(article, order) {
  if (!article) return;
  const detected = detectPlatform(order.shareUrl);
  const platform = order.platform || detected.platform || "";
  const meta = platformMeta[platform];
  article.dataset.platform = meta.slug;
  article.querySelector(".platform-chip").textContent = platform || "待识别";
  article.querySelector(".share-label").textContent = meta.input;
  const input = article.querySelector('[data-action="share-input"]');
  input.placeholder = "粘贴 Omni Flow 或豆包公开分享链接，系统自动识别";
  article.querySelector('[data-action="open-platform"]').textContent = meta.open;
  article.querySelector(".job-message").textContent = order.message || statusMeta[order.state].message;
}

function renderControls() {
  const active = activeOrders().length;
  const hasRowSelection = Boolean(els.rowNumbers.value.trim());
  const releasable = state.orders.some((order) => ["claimed", "error"].includes(order.state));
  const submittable = state.orders.some((order) => ["claimed", "error"].includes(order.state) && detectPlatform(order.shareUrl).platform);
  els.assignee.disabled = active > 0 || claimBusy || batchBusy;
  els.rowNumbers.disabled = claimBusy || batchBusy || active >= MAX_ACTIVE_ORDERS;
  els.quantity.disabled = claimBusy || batchBusy || active >= MAX_ACTIVE_ORDERS || hasRowSelection;
  els.claim.disabled = !serverOnline || claimBusy || batchBusy || active >= MAX_ACTIVE_ORDERS;
  els.claim.querySelector("span").textContent = claimBusy ? "接单中…" : (hasRowSelection ? "领取指定行" : "批量接单");
  els.recover.disabled = batchBusy || !state.assignee;
  els.submitAll.disabled = batchBusy || !submittable;
  els.releaseAll.disabled = batchBusy || !releasable;
  els.clearCompleted.disabled = batchBusy || !state.orders.some((order) => ["completed", "lost"].includes(order.state));
}

function detectPlatform(value) {
  const flow = normalizeFlowShareUrl(value);
  if (flow) return { platform: "Omni", url: flow };
  const doubao = normalizeDoubaoShareUrl(value);
  if (doubao) return { platform: "豆包", url: doubao };
  return { platform: "", url: "" };
}

function startPendingPollers() {
  state.orders.filter((order) => order.state === "processing" && order.jobId).forEach((order) => pollOrder(order.recordId));
}
function activeOrders() { return state.orders.filter((order) => !["completed", "lost"].includes(order.state)); }
function findOrder(recordId) { return state.orders.find((order) => order.recordId === recordId); }

function normalizeOrder(value) {
  const requestedState = String(value?.state || "claimed");
  const platform = Object.hasOwn(platformMeta, value?.platform) ? value.platform : "";
  return {
    recordId: String(value?.recordId || ""), lockId: String(value?.lockId || ""), assignee: String(value?.assignee || ""),
    platform, prompt: String(value?.prompt || ""), imageUrl: normalizeHttpUrl(value?.imageUrl),
    rowNumber: Number.isSafeInteger(Number(value?.rowNumber)) && Number(value.rowNumber) > 0 ? Number(value.rowNumber) : 0,
    shareUrl: String(value?.shareUrl || value?.flowShareUrl || ""), resultUrl: normalizeHttpUrl(value?.resultUrl || value?.videoUrl),
    state: Object.hasOwn(statusMeta, requestedState) ? requestedState : "claimed", jobId: String(value?.jobId || ""),
    message: String(value?.message || ""), createdAt: Number(value?.createdAt || Date.now()), completedAt: Number(value?.completedAt || 0),
  };
}

function loadState() {
  try {
    const legacy = !localStorage.getItem(STATE_KEY);
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || localStorage.getItem(LEGACY_STATE_KEY) || "{}");
    return {
      assignee: String(parsed.assignee || ""), quantity: normalizeBatchSize(parsed.quantity),
      claimJobId: String(parsed.claimJobId || ""),
      claimRequestId: String(parsed.claimRequestId || ""),
      claimCount: Number(parsed.claimCount || 0),
      claimRowNumbers: Array.isArray(parsed.claimRowNumbers) ? parsed.claimRowNumbers.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0) : [],
      orders: Array.isArray(parsed.orders) ? parsed.orders.map((order) => normalizeOrder({ ...order, platform: order.platform || (legacy ? "Omni" : "") })).filter((order) => order.recordId && order.lockId) : [],
    };
  } catch {
    return { assignee: "", quantity: DEFAULT_BATCH_SIZE, claimJobId: "", claimRequestId: "", claimCount: 0, claimRowNumbers: [], orders: [] };
  }
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

async function api(path, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(text.slice(0, 160) || `服务器返回异常 HTTP ${response.status}`); }
    if (!response.ok) throw new Error(data.error || `后端请求失败 HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请稍后重试");
    throw error;
  } finally { clearTimeout(timeout); }
}

function normalizeFlowShareUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.hostname !== "labs.google" || url.username || url.password) return "";
    const match = url.pathname.match(FLOW_PATH);
    return match ? `https://labs.google/fx/tools/flow/shared/video/${match[1].toLowerCase()}` : "";
  } catch { return ""; }
}

function normalizeDoubaoShareUrl(value) {
  const match = String(value || "").trim().match(/https:\/\/www\.doubao\.com\/thread\/[^\s"'<>?#]+/i);
  if (!match) return "";
  try {
    const url = new URL(match[0]);
    return url.hostname === "www.doubao.com" && DOUBAO_PATH.test(url.pathname) ? `${url.origin}${url.pathname.replace(/\/$/, "")}` : "";
  } catch { return ""; }
}

function normalizeHttpUrl(value) {
  try { const url = new URL(String(value || "").trim()); return ["http:", "https:"].includes(url.protocol) ? url.toString() : ""; }
  catch { return ""; }
}

function imageProxyUrl(url, preview = false) {
  const params = new URLSearchParams({ url });
  if (preview) { params.set("preview", "1"); params.set("w", "720"); params.set("q", "82"); }
  return `${API}/api/image-proxy?${params}`;
}

async function copyImage(order) {
  if (!order.imageUrl) return;
  try {
    const response = await fetch(imageProxyUrl(order.imageUrl));
    if (!response.ok) throw new Error("图片读取失败");
    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    showToast("图片已复制到剪贴板");
  } catch { await copyText(order.imageUrl, "图片地址已复制"); }
}

async function copyText(value, message) {
  if (!value) return;
  try { await navigator.clipboard.writeText(String(value)); showToast(message); }
  catch { showToast("复制失败，请手动选择内容", "error"); }
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  async function run() { while (cursor < items.length) await worker(items[cursor++]); }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function setDeck(message, tone = "") { els.deckMessage.textContent = message; els.deckMessage.className = `deck-message${tone ? ` ${tone}` : ""}`; }
function showToast(message, tone = "") { clearTimeout(toastTimer); els.toast.textContent = message; els.toast.className = `toast show${tone ? ` ${tone}` : ""}`; toastTimer = setTimeout(() => { els.toast.className = "toast"; }, 2600); }
function shortId(value) { const text = String(value || ""); return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text; }
function pad(value) { return String(value).padStart(2, "0"); }
function normalizeBatchSize(value) { const size = Number(value); return BATCH_SIZE_OPTIONS.includes(size) ? size : DEFAULT_BATCH_SIZE; }
function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `claim-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
function parseRowNumbers(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const tokens = text.replace(/\s*([-~～—–])\s*/g, "$1").split(/[,，、\s]+/).filter(Boolean);
  const rows = [];
  const seen = new Set();
  for (const token of tokens) {
    const match = token.match(/^(\d+)(?:[-~～—–](\d+))?$/);
    if (!match) throw new Error(`行号格式不正确：${token}`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 1000000) {
      throw new Error(`行号范围无效：${token}`);
    }
    for (let row = start; row <= end; row += 1) {
      if (!seen.has(row)) { seen.add(row); rows.push(row); }
      if (rows.length > MAX_ACTIVE_ORDERS) throw new Error(`一次最多指定 ${MAX_ACTIVE_ORDERS} 个行号`);
    }
  }
  return rows;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

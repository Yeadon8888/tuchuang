const API = "https://genvideo.mailab.top";
const FLOW_PATH = /^\/fx\/tools\/flow\/shared\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i;
const STATE_KEY = "mailab_omni_batch_workbench_v1";
const MAX_ACTIVE_ORDERS = 10;

const els = {
  serverState: document.getElementById("server-state"),
  serverStateText: document.getElementById("server-state-text"),
  claimForm: document.getElementById("claim-form"),
  assignee: document.getElementById("assignee-input"),
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

const statusMeta = {
  claimed: { label: "待制作", message: "等待填写 Flow 链接" },
  submitting: { label: "提交中", message: "正在创建转存任务" },
  processing: { label: "转存中", message: "正在获取 Flow 视频并转存 R2" },
  completed: { label: "已完成", message: "R2 已验证并完成飞书回填" },
  error: { label: "可重试", message: "处理失败，订单仍保持接单中" },
  lost: { label: "已失效", message: "订单锁已变化或任务已被释放" },
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
  els.quantity.value = String(state.quantity || 5);
  bindEvents();
  render();
  checkHealth();
  if (state.assignee && activeOrders().length) {
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
    state.quantity = clamp(Number(els.quantity.value) || 5, 1, MAX_ACTIVE_ORDERS);
    saveState();
  });
  els.recover.addEventListener("click", () => recoverOrders(false));
  els.submitAll.addEventListener("click", submitAllReady);
  els.releaseAll.addEventListener("click", releaseAllUnsubmitted);
  els.clearCompleted.addEventListener("click", clearFinishedCards);
  els.grid.addEventListener("input", handleGridInput);
  els.grid.addEventListener("click", handleGridClick);
}

async function checkHealth() {
  try {
    const response = await fetch(`${API}/api/health`, { cache: "no-store" });
    const data = await response.json();
    const features = Array.isArray(data.features) ? data.features : [];
    if (!response.ok || !data.ok || !features.includes("omni-batch")) {
      throw new Error("后端尚未部署批量功能");
    }
    serverOnline = true;
    els.serverState.className = "server-state online";
    els.serverStateText.textContent = "后端在线 · R2 已连接";
  } catch (error) {
    serverOnline = false;
    els.serverState.className = "server-state offline";
    els.serverStateText.textContent = error.message || "后端连接失败";
  }
  renderControls();
}

async function claimBatch(event) {
  event.preventDefault();
  if (claimBusy) return;
  const assignee = els.assignee.value.trim();
  const count = clamp(Number(els.quantity.value) || 5, 1, MAX_ACTIVE_ORDERS);
  const activeCount = activeOrders().length;
  if (!assignee) return setDeck("请先填写接单人。", "error");
  if (activeCount + count > MAX_ACTIVE_ORDERS) {
    return setDeck(`当前已持有 ${activeCount} 单，本次最多还能领取 ${MAX_ACTIVE_ORDERS - activeCount} 单。`, "error");
  }

  state.assignee = assignee;
  state.quantity = count;
  claimBusy = true;
  setDeck(`正在领取 ${count} 个 Omni 订单，请稍候…`, "warn");
  renderControls();
  try {
    const data = await api("/api/omni/claim-batch", { assignee, count }, 120000);
    if (!data.ok || !Array.isArray(data.orders) || !data.orders.length) {
      throw new Error(data.error || "暂无待接单任务");
    }
    const known = new Set(state.orders.map((order) => order.recordId));
    const added = data.orders
      .filter((order) => order.recordId && order.lockId && !known.has(order.recordId))
      .map((order) => normalizeOrder({ ...order, state: "claimed", message: "接单成功，等待制作", createdAt: Date.now() }));
    state.orders.push(...added);
    saveState();
    render();
    const suffix = data.partial ? `；其余未领取：${data.error || "任务不足"}` : "";
    setDeck(`成功领取 ${added.length} 单${suffix}`, data.partial ? "warn" : "success");
    showToast(`已加入 ${added.length} 张制作卡片`);
  } catch (error) {
    setDeck(error.message || "批量接单失败", "error");
  } finally {
    claimBusy = false;
    renderControls();
  }
}

async function recoverOrders(silent = false) {
  const candidates = activeOrders().map(({ recordId, lockId }) => ({ recordId, lockId }));
  if (!state.assignee) {
    if (!silent) setDeck("没有接单人信息，无法恢复订单。", "error");
    return;
  }
  if (!candidates.length) {
    if (!silent) setDeck("当前没有需要恢复的活动订单。", "warn");
    return;
  }
  if (!silent) setDeck(`正在校验 ${candidates.length} 个订单锁…`, "warn");
  try {
    const data = await api("/api/omni/recover", { assignee: state.assignee, orders: candidates }, 60000);
    if (!data.ok) throw new Error(data.error || "恢复失败");
    const recoveredById = new Map((data.orders || []).map((order) => [order.recordId, order]));
    const missingById = new Map((data.missing || []).map((order) => [order.recordId, order]));

    state.orders = state.orders.map((local) => {
      if (["completed", "lost"].includes(local.state)) return local;
      const recovered = recoveredById.get(local.recordId);
      if (recovered) {
        const next = normalizeOrder({
          ...local,
          ...recovered,
          flowShareUrl: local.flowShareUrl || recovered.flowShareUrl || "",
          resultUrl: recovered.videoUrl || local.resultUrl || "",
          message: recovered.message || "订单已恢复",
        });
        if (recovered.state === "claimed" && local.state === "processing") {
          next.state = "error";
          next.jobId = "";
          next.message = "后台任务已结束或服务重启，可使用原链接重新提交";
        }
        return next;
      }
      const missing = missingById.get(local.recordId);
      return normalizeOrder({ ...local, state: "lost", jobId: "", message: missing?.reason || "订单锁已经失效" });
    });
    saveState();
    render();
    startPendingPollers();
    if (!silent) setDeck(`恢复完成：${data.orders?.length || 0} 个有效订单。`, "success");
  } catch (error) {
    if (!silent) setDeck(error.message || "恢复订单失败", "error");
  }
}

function handleGridInput(event) {
  if (event.target.dataset.action !== "flow-input") return;
  const card = event.target.closest("[data-record-id]");
  const order = findOrder(card?.dataset.recordId);
  if (!order || ["processing", "submitting", "completed", "lost"].includes(order.state)) return;
  order.flowShareUrl = event.target.value.trim();
  if (order.state === "error") {
    order.message = "链接已更新，可以重新提交";
  }
  saveState();
  renderControls();
}

function handleGridClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button || button.dataset.action === "flow-input") return;
  const card = button.closest("[data-record-id]");
  const order = findOrder(card?.dataset.recordId);
  if (!order) return;
  const action = button.dataset.action;
  if (action === "submit") submitOrder(order.recordId);
  else if (action === "release") releaseOrder(order.recordId);
  else if (action === "copy-prompt") copyText(order.prompt, "提示词已复制");
  else if (action === "copy-image") copyImage(order);
  else if (action === "copy-id") copyText(order.recordId, "任务 ID 已复制");
  else if (action === "open-flow") window.open("https://labs.google/fx/tools/flow", "_blank", "noopener,noreferrer");
}

async function submitOrder(recordId) {
  const order = findOrder(recordId);
  if (!order || ["submitting", "processing", "completed", "lost"].includes(order.state)) return;
  const flowShareUrl = normalizeFlowShareUrl(order.flowShareUrl);
  if (!flowShareUrl) {
    order.state = "error";
    order.message = "请输入有效的 Flow 单视频公开分享链接";
    saveState();
    render();
    return;
  }
  const duplicate = state.orders.find((item) => item.recordId !== recordId && normalizeFlowShareUrl(item.flowShareUrl) === flowShareUrl && item.state !== "lost");
  if (duplicate) {
    order.state = "error";
    order.message = `该视频已填写在 ${shortId(duplicate.recordId)}，请检查对应关系`;
    saveState();
    render();
    return;
  }

  order.flowShareUrl = flowShareUrl;
  order.state = "submitting";
  order.message = "正在把 Flow 链接绑定到当前订单";
  saveState();
  render();
  try {
    const data = await api("/api/omni/complete", {
      recordId: order.recordId,
      lockId: order.lockId,
      assignee: state.assignee || order.assignee,
      flowShareUrl,
    }, 45000);
    if (!data.ok || !data.jobId) throw new Error(data.error || "转存任务创建失败");
    order.state = "processing";
    order.jobId = data.jobId;
    order.message = data.message || "正在转存 R2";
    saveState();
    render();
    pollOrder(order.recordId);
  } catch (error) {
    order.state = "error";
    order.jobId = "";
    order.message = error.message || "提交失败，订单仍保持接单中";
    saveState();
    render();
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
        const data = await api("/api/omni/complete-status", { jobId }, 20000);
        networkErrors = 0;
        if (data.status === "completed") {
          current.state = "completed";
          current.jobId = "";
          current.resultUrl = data.videoUrl || "";
          current.message = "R2 已验证，飞书订单已完成";
          current.completedAt = Date.now();
          saveState();
          render();
          showToast(`${shortId(recordId)} 已完成回填`);
          return;
        }
        if (data.status === "failed" || data.status === "missing" || data.ok === false) {
          current.state = "error";
          current.jobId = "";
          current.message = data.error || data.message || "转存失败，可使用原链接重试";
          saveState();
          render();
          return;
        }
        current.message = data.message || "正在转存 R2";
        saveState();
        render();
      } catch (error) {
        networkErrors += 1;
        const currentOrder = findOrder(recordId);
        if (!currentOrder) return;
        currentOrder.message = networkErrors >= 3 ? "网络暂时不稳定，仍在自动查询后台状态" : (error.message || "状态查询失败，正在重试");
        saveState();
        render();
      }
      await delay(networkErrors ? 4000 : 2000);
    }
    const current = findOrder(recordId);
    if (current?.state === "processing") {
      current.message = "转存仍在后台进行，刷新页面后会继续恢复";
      saveState();
      render();
    }
  } finally {
    pollers.delete(recordId);
  }
}

async function submitAllReady() {
  if (batchBusy) return;
  const editable = state.orders.filter((order) => ["claimed", "error"].includes(order.state));
  const groups = new Map();
  editable.forEach((order) => {
    const normalized = normalizeFlowShareUrl(order.flowShareUrl);
    if (!normalized) return;
    const group = groups.get(normalized) || [];
    group.push(order);
    groups.set(normalized, group);
  });
  for (const group of groups.values()) {
    if (group.length > 1) {
      group.forEach((order) => {
        order.state = "error";
        order.message = "这个 Flow 链接在当前队列中重复，请只保留一条";
      });
    }
  }
  const candidates = editable.filter((order) => {
    const normalized = normalizeFlowShareUrl(order.flowShareUrl);
    return normalized && (groups.get(normalized)?.length || 0) === 1;
  });
  if (!candidates.length) {
    saveState();
    render();
    return setDeck("没有可提交的有效链接；请先检查每张卡片。", "warn");
  }

  batchBusy = true;
  setDeck(`正在提交 ${candidates.length} 个转存任务…`, "warn");
  renderControls();
  await runPool(candidates, 3, (order) => submitOrder(order.recordId));
  batchBusy = false;
  setDeck(`${candidates.length} 个任务已提交，转存结果会分别显示在卡片中。`, "success");
  renderControls();
}

async function releaseOrder(recordId) {
  const order = findOrder(recordId);
  if (!order || !["claimed", "error"].includes(order.state)) return;
  if (!window.confirm(`确认释放订单 ${shortId(recordId)}？释放后会回到公共任务池。`)) return;
  order.message = "正在释放订单";
  saveState();
  render();
  try {
    const data = await api("/api/release", {
      recordId: order.recordId,
      lockId: order.lockId,
      assignee: state.assignee || order.assignee,
      platform: "Omni",
      reason: "用户在 Omni 批量工作台释放任务",
    });
    if (!data.ok) throw new Error(data.error || "释放失败");
    state.orders = state.orders.filter((item) => item.recordId !== recordId);
    saveState();
    render();
    showToast(`${shortId(recordId)} 已释放`);
  } catch (error) {
    order.state = "error";
    order.message = error.message || "释放失败";
    saveState();
    render();
  }
}

async function releaseAllUnsubmitted() {
  if (batchBusy) return;
  const candidates = state.orders.filter((order) => ["claimed", "error"].includes(order.state));
  if (!candidates.length) return setDeck("没有可批量释放的未转存订单。", "warn");
  if (!window.confirm(`确认释放 ${candidates.length} 个未转存订单？`)) return;

  batchBusy = true;
  setDeck(`正在释放 ${candidates.length} 个订单…`, "warn");
  renderControls();
  try {
    const data = await api("/api/omni/release-batch", {
      assignee: state.assignee,
      orders: candidates.map(({ recordId, lockId }) => ({ recordId, lockId })),
    }, 60000);
    const resultById = new Map((data.results || []).map((result) => [result.recordId, result]));
    state.orders = state.orders.filter((order) => {
      const result = resultById.get(order.recordId);
      if (result?.ok) return false;
      if (result && !result.ok) {
        order.state = "error";
        order.message = result.error || "释放失败";
      }
      return true;
    });
    saveState();
    render();
    setDeck(`已释放 ${data.released || 0} 单${data.failed ? `，${data.failed} 单释放失败` : ""}。`, data.failed ? "warn" : "success");
  } catch (error) {
    setDeck(error.message || "批量释放失败", "error");
  } finally {
    batchBusy = false;
    renderControls();
  }
}

function clearFinishedCards() {
  const before = state.orders.length;
  state.orders = state.orders.filter((order) => !["completed", "lost"].includes(order.state));
  const removed = before - state.orders.length;
  if (!removed) return setDeck("当前没有可清理的已完成或失效卡片。", "warn");
  saveState();
  render();
  setDeck(`已清理 ${removed} 张历史卡片。`, "success");
}

function render() {
  const fragment = document.createDocumentFragment();
  state.orders.forEach((order, index) => fragment.appendChild(renderOrder(order, index)));
  els.grid.replaceChildren(fragment);
  els.empty.classList.toggle("hidden", state.orders.length > 0);

  const active = activeOrders().length;
  const processing = state.orders.filter((order) => ["submitting", "processing"].includes(order.state)).length;
  const completed = state.orders.filter((order) => order.state === "completed").length;
  els.metricActive.textContent = pad(active);
  els.metricProcessing.textContent = pad(processing);
  els.metricCompleted.textContent = pad(completed);
  renderControls();
}

function renderOrder(order, index) {
  const article = els.template.content.firstElementChild.cloneNode(true);
  const meta = statusMeta[order.state] || statusMeta.claimed;
  article.dataset.recordId = order.recordId;
  article.dataset.state = order.state;
  article.style.animationDelay = `${Math.min(index * 45, 360)}ms`;
  article.querySelector(".card-sequence").textContent = `ORDER ${pad(index + 1)}`;
  const recordButton = article.querySelector(".record-id");
  recordButton.textContent = order.recordId;
  recordButton.title = `复制任务 ID：${order.recordId}`;
  article.querySelector(".status-chip").textContent = meta.label;

  const frame = article.querySelector(".image-frame");
  const image = frame.querySelector("img");
  if (order.imageUrl) {
    frame.classList.add("has-image");
    frame.href = order.imageUrl;
    image.src = imageProxyUrl(order.imageUrl, true);
  } else {
    frame.removeAttribute("href");
    image.removeAttribute("src");
  }
  article.querySelector("textarea").value = order.prompt || "当前任务没有提示词";

  const flowInput = article.querySelector('[data-action="flow-input"]');
  flowInput.value = order.flowShareUrl || "";
  flowInput.disabled = ["submitting", "processing", "completed", "lost"].includes(order.state);
  const message = article.querySelector(".job-message");
  message.textContent = order.message || meta.message;
  article.querySelector(".job-percent").textContent = order.state === "processing" ? "R2" : (order.state === "completed" ? "100%" : "");

  const result = article.querySelector(".result-link");
  if (order.resultUrl) {
    result.href = order.resultUrl;
    result.classList.remove("hidden");
  }

  const submit = article.querySelector('[data-action="submit"]');
  submit.disabled = ["submitting", "processing", "completed", "lost"].includes(order.state);
  submit.textContent = order.state === "error" ? "重新转存并回填" : (order.state === "completed" ? "已完成" : "转存并回填");
  const release = article.querySelector('[data-action="release"]');
  release.disabled = !["claimed", "error"].includes(order.state);
  article.querySelector('[data-action="copy-prompt"]').disabled = !order.prompt;
  article.querySelector('[data-action="copy-image"]').disabled = !order.imageUrl;
  return article;
}

function renderControls() {
  const active = activeOrders().length;
  const releasable = state.orders.some((order) => ["claimed", "error"].includes(order.state));
  const submittable = state.orders.some((order) => ["claimed", "error"].includes(order.state) && normalizeFlowShareUrl(order.flowShareUrl));
  els.assignee.disabled = active > 0 || claimBusy || batchBusy;
  els.quantity.disabled = claimBusy || batchBusy || active >= MAX_ACTIVE_ORDERS;
  els.claim.disabled = !serverOnline || claimBusy || batchBusy || active >= MAX_ACTIVE_ORDERS;
  els.claim.querySelector("span").textContent = claimBusy ? "接单中…" : "批量接单";
  els.recover.disabled = batchBusy || !active;
  els.submitAll.disabled = batchBusy || !submittable;
  els.releaseAll.disabled = batchBusy || !releasable;
  els.clearCompleted.disabled = batchBusy || !state.orders.some((order) => ["completed", "lost"].includes(order.state));
}

function startPendingPollers() {
  state.orders.filter((order) => order.state === "processing" && order.jobId).forEach((order) => pollOrder(order.recordId));
}

function activeOrders() {
  return state.orders.filter((order) => !["completed", "lost"].includes(order.state));
}

function findOrder(recordId) {
  return state.orders.find((order) => order.recordId === recordId);
}

function normalizeOrder(value) {
  const requestedState = String(value?.state || "claimed");
  return {
    recordId: String(value?.recordId || ""),
    lockId: String(value?.lockId || ""),
    assignee: String(value?.assignee || ""),
    prompt: String(value?.prompt || ""),
    imageUrl: normalizeHttpUrl(value?.imageUrl),
    flowShareUrl: String(value?.flowShareUrl || ""),
    resultUrl: normalizeHttpUrl(value?.resultUrl || value?.videoUrl),
    state: Object.hasOwn(statusMeta, requestedState) ? requestedState : "claimed",
    jobId: String(value?.jobId || ""),
    message: String(value?.message || ""),
    createdAt: Number(value?.createdAt || Date.now()),
    completedAt: Number(value?.completedAt || 0),
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    return {
      assignee: String(parsed.assignee || ""),
      quantity: clamp(Number(parsed.quantity) || 5, 1, MAX_ACTIVE_ORDERS),
      orders: Array.isArray(parsed.orders) ? parsed.orders.map(normalizeOrder).filter((order) => order.recordId && order.lockId).slice(-20) : [],
    };
  } catch {
    return { assignee: "", quantity: 5, orders: [] };
  }
}

function saveState() {
  const active = state.orders.filter((order) => !["completed", "lost"].includes(order.state));
  const history = state.orders.filter((order) => ["completed", "lost"].includes(order.state)).slice(-10);
  state.orders = [...active, ...history];
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

async function api(path, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(text.slice(0, 160) || `服务器返回异常 HTTP ${response.status}`); }
    if (!response.ok) throw new Error(data.error || `后端请求失败 HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFlowShareUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { return ""; }
  if (url.protocol !== "https:" || url.hostname !== "labs.google" || url.username || url.password) return "";
  const match = url.pathname.match(FLOW_PATH);
  return match ? `https://labs.google/fx/tools/flow/shared/video/${match[1].toLowerCase()}` : "";
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function imageProxyUrl(url, preview = false) {
  const params = new URLSearchParams({ url });
  if (preview) {
    params.set("preview", "1");
    params.set("w", "720");
    params.set("q", "82");
  }
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
  } catch {
    await copyText(order.imageUrl, "图片地址已复制");
  }
}

async function copyText(value, message) {
  const text = String(value || "");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    showToast("复制失败，请手动选择内容", "error");
  }
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function setDeck(message, tone = "") {
  els.deckMessage.textContent = message;
  els.deckMessage.className = `deck-message${tone ? ` ${tone}` : ""}`;
}

function showToast(message, tone = "") {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast show${tone ? ` ${tone}` : ""}`;
  toastTimer = setTimeout(() => { els.toast.className = "toast"; }, 2600);
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

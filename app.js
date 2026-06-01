const API = "https://tuchuang-api.yeadon8888.workers.dev";
const AUTH_KEY = "tuchuang_auth";

const authOverlay = document.getElementById("auth-overlay");
const authForm = document.getElementById("auth-form");
const authInput = document.getElementById("auth-input");
const authError = document.getElementById("auth-error");
const app = document.getElementById("app");
const statusBanner = document.getElementById("status-banner");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const pickBtn = document.getElementById("pick-btn");
const progressArea = document.getElementById("progress-area");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const results = document.getElementById("results");
const records = document.getElementById("records");
const historyMeta = document.getElementById("history-meta");
const batchActions = document.getElementById("batch-actions");
const copyAllBtn = document.getElementById("copy-all-btn");
const clearResultsBtn = document.getElementById("clear-results-btn");
const refreshRecordsBtn = document.getElementById("refresh-records-btn");

const uploadedUrls = [];
let apiFeatures = {
  video: false,
  records: false,
  cleanup: false,
};

function getToken() {
  return localStorage.getItem(AUTH_KEY);
}

function saveToken(token) {
  localStorage.setItem(AUTH_KEY, token);
}

function clearToken() {
  localStorage.removeItem(AUTH_KEY);
}

function showApp() {
  authOverlay.classList.add("hidden");
  app.classList.remove("hidden");
  dropZone.focus({ preventScroll: true });
  checkApiFeatures();
}

function showAuth(message = "") {
  authOverlay.classList.remove("hidden");
  app.classList.add("hidden");
  authError.textContent = message || "请输入访问码";
  authError.classList.toggle("hidden", !message);
  authInput.focus();
}

function updateBatchActions() {
  batchActions.classList.toggle("hidden", uploadedUrls.length === 0);
}

if (getToken()) {
  showApp();
} else {
  authInput.focus();
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = authInput.value.trim();
  if (!code) {
    showAuth("请输入访问码");
    return;
  }

  saveToken(code);
  authInput.value = "";
  authError.classList.add("hidden");
  showApp();
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showAuth("已退出，请输入新的访问码");
});

pickBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => handleFiles(fileInput.files));

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFiles(event.dataTransfer.files);
});

document.addEventListener("paste", (event) => {
  if (!getToken()) return;
  const items = Array.from(event.clipboardData?.items || []);
  const files = items
    .filter((item) => item.type.startsWith("image/") || item.type.startsWith("video/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (files.length) handleFiles(files);
});

copyAllBtn.addEventListener("click", async () => {
  await copyText(uploadedUrls.join("\n"), copyAllBtn, "复制全部链接");
});

clearResultsBtn.addEventListener("click", () => {
  uploadedUrls.length = 0;
  results.textContent = "";
  updateBatchActions();
});

refreshRecordsBtn.addEventListener("click", () => loadRecords());

async function checkApiFeatures() {
  try {
    const res = await fetch(`${API}/healthz`);
    const data = await res.json();
    const features = data.features || [];
    apiFeatures = {
      video: features.includes("video-upload"),
      records: features.includes("records"),
      cleanup: features.includes("auto-cleanup"),
    };
    statusBanner.classList.toggle("hidden", apiFeatures.video && apiFeatures.records);
    statusBanner.textContent = apiFeatures.video && apiFeatures.records
      ? ""
      : "当前 Worker 还不是视频/记录版本。图片仍可上传，视频和记录需要先部署新版 Worker。";
  } catch {
    apiFeatures = { video: false, records: false, cleanup: false };
    statusBanner.classList.remove("hidden");
    statusBanner.textContent = "当前 Worker 还不是视频/记录版本。图片仍可上传，视频和记录需要先部署新版 Worker。";
  }

  if (apiFeatures.records) loadRecords();
  else {
    historyMeta.textContent = "部署新版 Worker 后会显示最近上传记录。";
    records.textContent = "";
  }
}

async function uploadFile(file) {
  const form = new FormData();
  form.append("file", file, file.name || defaultFileName(file));

  const res = await fetch(`${API}/upload`, {
    method: "POST",
    headers: { "X-Auth-Code": getToken() },
    body: form,
  });

  return readApiResponse(res);
}

async function handleFiles(fileList) {
  const incoming = Array.from(fileList);
  const blockedVideos = incoming.filter((file) => file.type.startsWith("video/") && !apiFeatures.video);
  const files = incoming.filter(isSupportedFile).filter((file) => apiFeatures.video || !file.type.startsWith("video/"));
  blockedVideos.forEach((file) => {
    addError(file.name || "视频文件", "新版 Worker 部署后才支持视频上传");
  });

  if (!files.length) {
    addError("未找到可上传文件", "请选择图片或视频文件");
    return;
  }

  progressArea.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressText.textContent = `准备上传 ${files.length} 个文件`;

  let successCount = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    progressText.textContent = `上传中 ${i + 1} / ${files.length}：${file.name || "未命名文件"}`;
    progressBar.style.width = `${Math.round((i / files.length) * 100)}%`;

    try {
      const data = await uploadFile(file);
      addResult(file, data);
      successCount += 1;
    } catch (error) {
      addError(file.name || "未命名文件", error.message);
    }

    progressBar.style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
  }

  progressText.textContent = `完成：成功 ${successCount} 个，失败 ${files.length - successCount} 个`;
  setTimeout(() => progressArea.classList.add("hidden"), 2400);
  fileInput.value = "";
  if (successCount && apiFeatures.records) loadRecords();
}

async function loadRecords() {
  if (!getToken() || !apiFeatures.records) return;
  historyMeta.textContent = "正在读取上传记录...";

  try {
    const res = await fetch(`${API}/files?limit=60`, {
      headers: { "X-Auth-Code": getToken() },
    });
    const data = await readApiResponse(res);
    renderRecords(data.files || [], data.retentionDays || 7);
  } catch (error) {
    historyMeta.textContent = error.message;
    records.textContent = "";
  }
}

function renderRecords(files, retentionDays) {
  records.textContent = "";
  historyMeta.textContent = files.length
    ? `显示最近 ${files.length} 个文件，R2 内 ${retentionDays} 天后自动清理。`
    : `暂无记录。上传后的文件会在 R2 内保留 ${retentionDays} 天。`;

  files.forEach((file) => {
    records.appendChild(createFileCard(file, { isRecord: true }));
  });
}

function addResult(file, data) {
  uploadedUrls.unshift(data.url);
  updateBatchActions();
  results.prepend(createFileCard({
    ...data,
    name: file.name || data.name || "未命名文件",
    contentType: file.type || data.contentType,
    size: file.size || data.size,
    previewUrl: URL.createObjectURL(file),
  }));
}

function createFileCard(file, options = {}) {
  const item = document.createElement("div");
  item.className = "result-item";
  item.innerHTML = `
    ${renderPreview(file)}
    <div class="result-info">
      <div class="result-name">${escapeHtml(file.name || "未命名文件")}</div>
      <a class="result-url" href="${escapeAttribute(file.url)}" target="_blank" rel="noreferrer">${escapeHtml(file.url)}</a>
      <div class="result-meta">${escapeHtml(buildMeta(file))}</div>
    </div>
    <div class="copy-group">
      <button class="copy-btn" data-copy="${escapeAttribute(file.url)}">URL</button>
      <button class="copy-btn" data-copy="${escapeAttribute(file.markdown || buildMarkdown(file))}">Markdown</button>
      <button class="copy-btn" data-copy="${escapeAttribute(file.html || buildHtml(file))}">HTML</button>
      ${options.isRecord ? `<button class="copy-btn danger" data-delete="${escapeAttribute(file.key)}">删除</button>` : ""}
    </div>
  `;

  item.querySelectorAll("[data-copy]").forEach((button) => {
    const label = button.textContent;
    button.addEventListener("click", () => copyText(button.dataset.copy, button, label));
  });

  const deleteBtn = item.querySelector("[data-delete]");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => deleteRecord(file.key, item));
  }

  return item;
}

function renderPreview(file) {
  const url = file.previewUrl || file.url;
  if (isVideo(file)) {
    return `<video class="result-thumb" src="${escapeAttribute(url)}" muted playsinline controls></video>`;
  }
  return `<img class="result-thumb" src="${escapeAttribute(url)}" alt="" />`;
}

async function deleteRecord(key, item) {
  try {
    const res = await fetch(`${API}/file/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { "X-Auth-Code": getToken() },
    });
    await readApiResponse(res);
    item.remove();
    loadRecords();
  } catch (error) {
    addError("删除失败", error.message);
  }
}

function addError(name, message) {
  const item = document.createElement("div");
  item.className = "result-item error-item";
  item.innerHTML = `
    <div class="error-mark">!</div>
    <div class="result-info">
      <div class="result-name">${escapeHtml(name)}</div>
      <div class="result-error">${escapeHtml(message)}</div>
    </div>
  `;
  results.prepend(item);
}

async function readApiResponse(res) {
  if (res.status === 401) {
    clearToken();
    showAuth("访问码不对，请重新输入");
    throw new Error("访问码不对");
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    throw new Error(data.error || "请求失败，请稍后重试");
  }

  return data;
}

async function copyText(text, button, originalLabel) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "已复制";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = originalLabel;
      button.classList.remove("copied");
    }, 1600);
  } catch {
    button.textContent = "复制失败";
    setTimeout(() => {
      button.textContent = originalLabel;
    }, 1600);
  }
}

function isSupportedFile(file) {
  return file.type.startsWith("image/") || file.type.startsWith("video/");
}

function isVideo(file) {
  return file.kind === "video" || file.contentType?.startsWith("video/");
}

function defaultFileName(file) {
  return file.type.startsWith("video/") ? "video.mp4" : "image.png";
}

function buildMarkdown(file) {
  return isVideo(file) ? `[${file.name || "视频"}](${file.url})` : `![](${file.url})`;
}

function buildHtml(file) {
  return isVideo(file)
    ? `<video src="${file.url}" controls></video>`
    : `<img src="${file.url}" alt="" />`;
}

function buildMeta(file) {
  const parts = [];
  if (file.contentType) parts.push(file.contentType);
  if (file.size) parts.push(formatBytes(file.size));
  if (file.uploadedAt) parts.push(`上传 ${formatDate(file.uploadedAt)}`);
  if (file.expiresAt) parts.push(`清理 ${formatDate(file.expiresAt)}`);
  return parts.join(" · ");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDate(value) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

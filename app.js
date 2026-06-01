const API = "https://tuchuang-api.yeadon8888.workers.dev";
const AUTH_KEY = "tuchuang_auth";

const authOverlay = document.getElementById("auth-overlay");
const authForm = document.getElementById("auth-form");
const authInput = document.getElementById("auth-input");
const authError = document.getElementById("auth-error");
const app = document.getElementById("app");
const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const pickBtn = document.getElementById("pick-btn");
const progressArea = document.getElementById("progress-area");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const results = document.getElementById("results");
const batchActions = document.getElementById("batch-actions");
const copyAllBtn = document.getElementById("copy-all-btn");
const clearResultsBtn = document.getElementById("clear-results-btn");

const uploadedUrls = [];

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
  const imageFiles = items
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (imageFiles.length) handleFiles(imageFiles);
});

copyAllBtn.addEventListener("click", async () => {
  await copyText(uploadedUrls.join("\n"), copyAllBtn, "复制全部链接");
});

clearResultsBtn.addEventListener("click", () => {
  uploadedUrls.length = 0;
  results.textContent = "";
  updateBatchActions();
});

function toPng(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("图片转换失败"))),
        "image/png"
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };

    img.src = url;
  });
}

async function uploadFile(file) {
  const pngBlob = await toPng(file);
  const form = new FormData();
  form.append("file", pngBlob, "image.png");

  const res = await fetch(`${API}/upload`, {
    method: "POST",
    headers: { "X-Auth-Code": getToken() },
    body: form,
  });

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
    throw new Error(data.error || "上传失败，请稍后重试");
  }

  return data;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    addError("未找到图片", "请选择图片文件");
    return;
  }

  progressArea.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressText.textContent = `准备上传 ${files.length} 张`;

  let successCount = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    progressText.textContent = `上传中 ${i + 1} / ${files.length}：${file.name || "截图"}`;
    progressBar.style.width = `${Math.round((i / files.length) * 100)}%`;

    try {
      const data = await uploadFile(file);
      addResult(file, data);
      successCount += 1;
    } catch (error) {
      addError(file.name || "截图", error.message);
    }

    progressBar.style.width = `${Math.round(((i + 1) / files.length) * 100)}%`;
  }

  progressText.textContent = `完成：成功 ${successCount} 张，失败 ${files.length - successCount} 张`;
  setTimeout(() => progressArea.classList.add("hidden"), 2400);
  fileInput.value = "";
}

function addResult(file, data) {
  const url = data.url;
  const thumb = URL.createObjectURL(file);
  uploadedUrls.unshift(url);
  updateBatchActions();

  const item = document.createElement("div");
  item.className = "result-item";
  item.innerHTML = `
    <img class="result-thumb" src="${thumb}" alt="" />
    <div class="result-info">
      <div class="result-name">${escapeHtml(file.name || "粘贴的图片")}</div>
      <a class="result-url" href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>
    </div>
    <div class="copy-group">
      <button class="copy-btn" data-copy="${escapeAttribute(url)}">URL</button>
      <button class="copy-btn" data-copy="${escapeAttribute(data.markdown || `![](${url})`)}">Markdown</button>
      <button class="copy-btn" data-copy="${escapeAttribute(data.html || `<img src="${url}" alt="" />`)}">HTML</button>
    </div>
  `;

  item.querySelectorAll(".copy-btn").forEach((button) => {
    const label = button.textContent;
    button.addEventListener("click", () => copyText(button.dataset.copy, button, label));
  });

  results.prepend(item);
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

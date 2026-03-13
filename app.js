const API = "https://tuchuang-api.yeadon8888.workers.dev";
const AUTH_KEY = "tuchuang_auth";

// ── 认证 ──────────────────────────────────────────
const authOverlay = document.getElementById("auth-overlay");
const authInput   = document.getElementById("auth-input");
const authBtn     = document.getElementById("auth-btn");
const authError   = document.getElementById("auth-error");
const app         = document.getElementById("app");

function getToken() { return localStorage.getItem(AUTH_KEY); }
function saveToken(t) { localStorage.setItem(AUTH_KEY, t); }
function clearToken() { localStorage.removeItem(AUTH_KEY); }

function showApp() {
  authOverlay.classList.add("hidden");
  app.classList.remove("hidden");
}

function showAuth() {
  authOverlay.classList.remove("hidden");
  app.classList.add("hidden");
}

if (getToken()) {
  showApp();
}

authBtn.addEventListener("click", () => {
  const code = authInput.value.trim();
  if (code === "1214") {
    saveToken(code);
    authError.classList.add("hidden");
    showApp();
  } else {
    authError.classList.remove("hidden");
    authInput.value = "";
    authInput.focus();
  }
});

authInput.addEventListener("keydown", e => { if (e.key === "Enter") authBtn.click(); });

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showAuth();
});

// ── 上传逻辑 ──────────────────────────────────────
const dropZone     = document.getElementById("drop-zone");
const fileInput    = document.getElementById("file-input");
const pickBtn      = document.getElementById("pick-btn");
const progressArea = document.getElementById("progress-area");
const progressBar  = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const results      = document.getElementById("results");

pickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => handleFiles(fileInput.files));

// 拖拽
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFiles(e.dataTransfer.files);
});

// 粘贴
document.addEventListener("paste", e => {
  if (!getToken()) return;
  const items = e.clipboardData.items;
  const imageFiles = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      imageFiles.push(item.getAsFile());
    }
  }
  if (imageFiles.length) handleFiles(imageFiles);
});

// 转 PNG（浏览器端 Canvas）
function toPng(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("转换失败")), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片加载失败")); };
    img.src = url;
  });
}

async function uploadFile(file, index, total) {
  const pngBlob = await toPng(file);
  const form = new FormData();
  form.append("file", pngBlob, "image.png");

  const res = await fetch(`${API}/upload`, {
    method: "POST",
    headers: { "X-Auth-Code": getToken() },
    body: form,
  });

  if (res.status === 401) { clearToken(); showAuth(); throw new Error("认证失败"); }
  if (!res.ok) throw new Error("上传失败");

  return res.json();
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith("image/"));
  if (!files.length) return;

  progressArea.classList.remove("hidden");
  progressBar.style.width = "0%";

  for (let i = 0; i < files.length; i++) {
    progressText.textContent = `上传中 ${i + 1} / ${files.length}`;
    progressBar.style.width = `${(i / files.length) * 100}%`;

    try {
      const data = await uploadFile(files[i], i, files.length);
      addResult(files[i], data.url);
    } catch (err) {
      addError(files[i].name, err.message);
    }

    progressBar.style.width = `${((i + 1) / files.length) * 100}%`;
  }

  progressText.textContent = `完成 ${files.length} 张`;
  setTimeout(() => progressArea.classList.add("hidden"), 2000);
  fileInput.value = "";
}

function addResult(file, url) {
  const thumb = URL.createObjectURL(file);
  const item = document.createElement("div");
  item.className = "result-item";
  item.innerHTML = `
    <img class="result-thumb" src="${thumb}" alt="" />
    <div class="result-info">
      <div class="result-url">${url}</div>
    </div>
    <button class="copy-btn" data-url="${url}">复制链接</button>
  `;
  item.querySelector(".copy-btn").addEventListener("click", function () {
    navigator.clipboard.writeText(this.dataset.url).then(() => {
      this.textContent = "已复制 ✓";
      this.classList.add("copied");
      setTimeout(() => { this.textContent = "复制链接"; this.classList.remove("copied"); }, 2000);
    });
  });
  results.prepend(item);
}

function addError(name, msg) {
  const item = document.createElement("div");
  item.className = "result-item";
  item.style.borderColor = "var(--error)";
  item.innerHTML = `<div style="color:var(--error)">❌ ${name} — ${msg}</div>`;
  results.prepend(item);
}

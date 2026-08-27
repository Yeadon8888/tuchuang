const API_BASE = 'https://genvideo.mailab.top';
const RESOLVER_BASE = 'https://tuchuang-api.yeadon8888.workers.dev';
const POLL_INTERVAL_MS = 1800;
const STAGES = ['resolving', 'downloading', 'uploading', 'completed'];

const elements = {
  url: document.querySelector('#share-url'),
  submit: document.querySelector('#submit-button'),
  paste: document.querySelector('#paste-button'),
  hint: document.querySelector('#input-hint'),
  progress: document.querySelector('#progress-panel'),
  progressKicker: document.querySelector('#progress-kicker'),
  progressMessage: document.querySelector('#progress-message'),
  elapsed: document.querySelector('#elapsed-time'),
  fill: document.querySelector('#progress-fill'),
  steps: [...document.querySelectorAll('.steps li')],
  result: document.querySelector('#result-panel'),
  resultUrl: document.querySelector('#result-url'),
  open: document.querySelector('#open-button'),
  copy: document.querySelector('#copy-button'),
  error: document.querySelector('#error-panel'),
  errorMessage: document.querySelector('#error-message'),
  retry: document.querySelector('#retry-button')
};

let busy = false;
let startedAt = 0;
let elapsedTimer = 0;

elements.submit.addEventListener('click', startTransfer);
elements.retry.addEventListener('click', startTransfer);
elements.copy.addEventListener('click', copyResult);
elements.paste.addEventListener('click', pasteFromClipboard);
elements.url.addEventListener('input', () => setInputState(true));
elements.url.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') startTransfer();
});

async function startTransfer() {
  if (busy) return;
  const url = normalizeInput(elements.url.value);
  if (!isDoubaoThreadUrl(url)) {
    setInputState(false, '请输入有效的豆包公开分享链接（doubao.com/thread/...）');
    elements.url.focus();
    return;
  }

  setBusy(true);
  resetPanels();
  showProgress('resolving', '正在提交转存任务');
  try {
    const fallbackApi = await resolveFromVisitorRegion(url);
    showProgress('resolving', '已读取分享页，正在安全解码视频');
    const started = await request('/api/doubao/archive', { url, fallbackApi });
    if (!started.jobId) throw new Error(started.error || '后端未返回任务编号');
    await pollJob(started.jobId);
  } catch (error) {
    showError(error.message || '转存失败，请稍后重试');
  } finally {
    setBusy(false);
  }
}

async function resolveFromVisitorRegion(url) {
  let response;
  try {
    const endpoint = new URL('/resolve/doubao-thread', RESOLVER_BASE);
    endpoint.searchParams.set('url', url);
    response = await fetch(endpoint, { cache: 'no-store' });
  } catch {
    throw new Error('无法读取豆包分享页，请检查网络后重试');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.fallbackApi) {
    throw new Error(data.error || '当前网络没有读取到豆包视频数据，请稍后重试');
  }
  return data.fallbackApi;
}

async function pollJob(jobId) {
  while (true) {
    const job = await request('/api/doubao/archive-status', { jobId });
    if (job.status === 'completed' && job.videoUrl) {
      showProgress('completed', job.message || '直链验证完成');
      showResult(job.videoUrl);
      return;
    }
    if (job.status === 'failed' || job.status === 'missing' || job.ok === false) {
      throw new Error(job.error || job.message || '转存任务失败');
    }
    showProgress(job.stage || 'resolving', job.message || '正在处理');
    await wait(POLL_INTERVAL_MS);
  }
}

async function request(path, body) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('无法连接转存服务，请检查网络后重试');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `服务请求失败（HTTP ${response.status}）`);
  return data;
}

function showProgress(stage, message) {
  elements.progress.classList.remove('is-hidden');
  elements.progressMessage.textContent = message;
  const activeIndex = Math.max(0, STAGES.indexOf(stage));
  elements.fill.style.width = `${[12, 42, 74, 100][activeIndex]}%`;
  elements.steps.forEach((step, index) => {
    step.classList.toggle('is-done', index < activeIndex || stage === 'completed');
    step.classList.toggle('is-active', index === activeIndex && stage !== 'completed');
  });
}

function showResult(url) {
  elements.resultUrl.href = url;
  elements.resultUrl.textContent = url;
  elements.open.href = url;
  elements.result.classList.remove('is-hidden');
  elements.result.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showError(message) {
  stopClock();
  elements.progressKicker.textContent = 'STOPPED';
  elements.errorMessage.textContent = message;
  elements.error.classList.remove('is-hidden');
  elements.error.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetPanels() {
  elements.result.classList.add('is-hidden');
  elements.error.classList.add('is-hidden');
  elements.progress.classList.add('is-hidden');
  elements.progressKicker.textContent = 'PROCESSING';
  elements.steps.forEach((step) => step.classList.remove('is-active', 'is-done'));
  elements.fill.style.width = '8%';
  startedAt = Date.now();
  stopClock();
  elapsedTimer = window.setInterval(updateClock, 1000);
  updateClock();
}

function setBusy(value) {
  busy = value;
  elements.submit.disabled = value;
  elements.submit.querySelector('.button-label').textContent = value ? '正在处理…' : '解析并转存 R2';
  if (!value) stopClock();
}

function setInputState(valid, message = '支持 doubao.com/thread/ 公开分享链接') {
  elements.hint.textContent = message;
  elements.hint.classList.toggle('invalid', !valid);
}

function updateClock() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  elements.elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function stopClock() {
  window.clearInterval(elapsedTimer);
  elapsedTimer = 0;
}

async function pasteFromClipboard() {
  try {
    elements.url.value = await navigator.clipboard.readText();
    setInputState(true);
    elements.url.focus();
  } catch {
    setInputState(false, '浏览器未允许读取剪贴板，请手动粘贴');
  }
}

async function copyResult() {
  const url = elements.resultUrl.href;
  try {
    await navigator.clipboard.writeText(url);
    elements.copy.textContent = '已复制 ✓';
    window.setTimeout(() => { elements.copy.textContent = '复制直链'; }, 1600);
  } catch {
    window.prompt('复制下面的直链：', url);
  }
}

function normalizeInput(value) {
  const match = String(value || '').trim().match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[，。；,.;]+$/, '') : '';
}

function isDoubaoThreadUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)doubao\.com$/i.test(url.hostname) && /^\/thread\/[^/?#]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

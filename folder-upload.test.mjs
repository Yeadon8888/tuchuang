import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('async function handleFiles('), source.indexOf('async function loadRecords('));

test('folder files and later selections share one serial queue, skip non-media and continue after failure', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const called = [], errors = [];
  let policy = 'temporary', active = 0, maxActive = 0;
  const progress = { textContent: '', style: {}, classList: { remove() {} } };
  const handle = new Function('getUploadStoragePolicy', 'isSupportedFile', 'addError', 'progressArea', 'progressBar', 'progressText', 'uploadFileWithRetry', 'addResult', 'apiFeatures', 'loadRecords', `const pendingUploads=[]; let uploadQueueRunning=false; ${handler}; return handleFiles;`)(
    () => policy, (file) => /^(image|video)\//.test(file.type), (...args) => errors.push(args), progress, progress, progress,
    async (file, _retry, storagePolicy) => {
      active++; maxActive = Math.max(maxActive, active); called.push([file.name, storagePolicy]);
      try {
        if (file.name === 'first.mp4') await waiting;
        if (file.name === 'bad.mp4') throw new Error('upload failed');
        return { url: file.name };
      } finally { active--; }
    }, () => {}, { records: false }, () => {},
  );
  const first = handle([{ name: 'first.mp4', type: 'video/mp4', webkitRelativePath: 'folder/sub/first.mp4' }, { name: 'note.txt', type: 'text/plain' }, { name: 'bad.mp4', type: 'video/mp4' }]);
  policy = 'permanent';
  await handle([{ name: 'last.jpg', type: 'image/jpeg' }]);
  assert.equal(called.length, 1);
  release();
  await first;
  assert.equal(maxActive, 1);
  assert.deepEqual(called, [['first.mp4', 'temporary'], ['bad.mp4', 'temporary'], ['last.jpg', 'permanent']]);
  assert.match(progress.textContent, /成功 2 个，失败 1 个/);
  assert.equal(errors.length, 2);
});

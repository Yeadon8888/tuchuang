import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

test('named uploads keep Unicode names, number duplicates, and retain the original object on retry and concurrency', async () => {
  const objects = new Map();
  let lostResponse = false;
  const env = { AUTH_CODE: 'test', IMAGES: {
    async head(key) { return objects.get(key) || null; },
    async put(key, body, options) {
      assert.equal(options.onlyIf.get('If-None-Match'), '*');
      if (objects.has(key)) return null;
      const record = { key, size: body.byteLength, body, customMetadata: options.customMetadata, uploaded: new Date() };
      objects.set(key, record);
      if (lostResponse) { lostResponse = false; throw new Error('response lost after successful write'); }
      return record;
    },
  } };
  const upload = async (id, content = 'video') => {
    const form = new FormData();
    form.set('file', new File([content], '产品演示 ภาษาไทย.mp4', { type: 'video/mp4' }));
    form.set('uploadId', `1790000000000-${id}`);
    form.set('storagePolicy', 'permanent');
    const res = await worker.fetch(new Request('https://api.test/upload', { method: 'POST', headers: { 'X-Auth-Code': 'test' }, body: form }), env);
    assert.equal(res.status, 200);
    return res.json();
  };
  const first = await upload('aaaaaaaa');
  const second = await upload('bbbbbbbb');
  assert.equal(first.key, 'permanent/产品演示 ภาษาไทย.mp4');
  assert.equal(second.key, 'permanent/产品演示 ภาษาไทย(1).mp4');
  assert.equal(decodeURIComponent(new URL(second.url).pathname), '/file/permanent/产品演示 ภาษาไทย(1).mp4');
  assert.equal((await upload('bbbbbbbb')).url, second.url);
  const concurrent = await Promise.all([upload('cccccccc', 'one'), upload('dddddddd', 'two')]);
  assert.equal(new Set(concurrent.map((f) => f.key)).size, 2);
  lostResponse = true;
  const recovered = await upload('eeeeeeee');
  assert.equal(recovered.key, 'permanent/产品演示 ภาษาไทย(4).mp4');
  assert.equal(objects.size, 5);
  assert.equal((await upload('eeeeeeee')).url, recovered.url);
});

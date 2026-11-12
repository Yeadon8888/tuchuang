import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

test('batch URLs include the latest 500 across storage prefixes and pages without file head requests', async () => {
  const objects = Array.from({ length: 1205 }, (_, i) => ({ key: `${i % 2 ? 'temporary' : 'permanent'}/${1790000000000 + i}-test.mp4`, uploaded: new Date(1790000000000 + i) }));
  const env = { AUTH_CODE: 'test-code', IMAGES: {
    async list({ prefix = '', cursor, limit }) {
      const matching = objects.filter((object) => object.key.startsWith(prefix)).sort((a,b) => a.key.localeCompare(b.key));
      const offset = Number(cursor || 0);
      const page = matching.slice(offset, offset + limit);
      return { objects: page, truncated: offset + limit < matching.length, cursor: String(offset + limit) };
    },
    async head() { throw new Error('copying links must not load each file'); },
  } };
  for (const [count, policy] of [[100, 'all'], [500, 'all'], [500, 'permanent']]) {
    const response = await worker.fetch(new Request(`https://api.example/files?limit=${count}&storagePolicy=${policy}&linksOnly=1`, { headers: { 'X-Auth-Code': 'test-code' } }), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    const expected = objects.filter((o) => policy === 'all' || o.key.startsWith(policy)).sort((a,b) => b.uploaded - a.uploaded).slice(0,count);
    assert.deepEqual(data.files.map((f) => f.url), expected.map((o) => `https://api.example/file/${encodeURIComponent(o.key)}`));
  }
  for (const limit of ['0', '501', '-1', '1.5', 'abc']) {
    const response = await worker.fetch(new Request(`https://api.example/files?limit=${limit}`, { headers: { 'X-Auth-Code': 'test-code' } }), env);
    assert.equal(response.status, 400);
  }
  const unauthorized = await worker.fetch(new Request('https://api.example/files?limit=500&linksOnly=1'), env);
  assert.equal(unauthorized.status, 401);
});

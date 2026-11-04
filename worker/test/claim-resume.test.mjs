import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { handleOrderQueue } from '../src/order-cloudflare.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function harness({ held = 0, requested = 100, interrupted = false } = {}) {
  const records = new Map(Array.from({ length: 120 }, (_, i) => [`rec${i}`, { record_id: `rec${i}`, fields: { 任务状态: '待接单' } }]));
  for (let i = 0; i < held; i++) records.set(`held${i}`, { record_id: `held${i}`, fields: { 任务状态: '接单中', 接单人: 'tester', 接单锁ID: `held-lock${i}` } });
  const job = { id: 'job1', type: 'claim', status: 'processing', assignee: 'tester', payload: JSON.stringify({ assignee: 'tester', requested, rowNumbers: [] }), result: '{}' };
  if (interrupted) {
    job.result = JSON.stringify({ targets: [{ recordId: 'rec0', rowNumber: 1 }], cursor: 0, orders: [], requested });
    records.get('rec0').fields = { 任务状态: '接单中', 接单人: 'tester', 接单锁ID: 'job1:rec0' };
  }
  let writes = 0;
  let sends = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    if (url.pathname.endsWith('/records')) {
      const owned = Boolean(url.searchParams.get('filter'));
      const items = [...records.values()].filter((r) => owned ? r.fields.接单人 === 'tester' && r.fields.任务状态 === '接单中' : r.fields.任务状态 === '待接单');
      return Response.json({ code: 0, data: { items, has_more: false } });
    }
    const id = decodeURIComponent(url.pathname.split('/records/')[1]);
    assert.ok(records.has(id), `unexpected record ${id}`);
    if (options.method === 'PUT') { writes++; records.get(id).fields = { ...records.get(id).fields, ...JSON.parse(options.body).fields }; }
    return Response.json({ code: 0, data: { record: records.get(id) } });
  };
  const env = {
    FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'test-secret', FEISHU_APP_TOKEN: 'base', FEISHU_TABLE_ID: 'table',
    ORDER_VIDEOS: {}, ORDER_JOBS: { async send() { sends++; } },
    ORDER_DB: { prepare(sql) { return { bind(...args) { return {
      async first() { return { ...job }; },
      async run() {
        if (sql.includes('UPDATE order_jobs SET result=')) { job.result = args[0]; job.message = args[1]; }
        if (sql.includes('UPDATE order_jobs SET status=')) { job.status = args[0]; job.result = args[1]; job.error = args[3]; }
        return { meta: { changes: 1 } };
      },
    }; } }; } },
  };
  const deliver = () => handleOrderQueue({ messages: [{ body: { kind: 'claim', jobId: 'job1' }, attempts: 1, ack() {}, retry() { throw new Error('unexpected retry'); } }] }, env);
  return { job, deliver, records, writes: () => writes, sends: () => sends };
}

test('100 requested orders finish in bounded deliveries; duplicate messages cannot claim more', async () => {
  const h = harness();
  await h.deliver();
  assert.equal(h.writes(), 1);
  assert.equal(JSON.parse(h.job.result).orders.length, 1);
  for (let i = 0; i < 110; i++) await h.deliver();
  assert.equal(h.job.status, 'completed');
  assert.equal(h.writes(), 100);
  assert.equal(JSON.parse(h.job.result).orders.length, 100);
});

test('crash after Feishu write resumes the same target and lock without claiming another record', async () => {
  const h = harness({ requested: 1, interrupted: true });
  await h.deliver();
  assert.equal(h.writes(), 0);
  assert.equal(h.job.status, 'completed');
  assert.equal(JSON.parse(h.job.result).orders[0].recordId, 'rec0');
});

test('server enforces total held limit across pages and requests', async () => {
  const h = harness({ held: 99, requested: 100 });
  for (let i = 0; i < 4; i++) await h.deliver();
  assert.equal(h.writes(), 1);
  assert.equal(h.job.status, 'completed');
  assert.equal(JSON.parse(h.job.result).claimed, 1);
  assert.match(h.job.error, /100/);
});

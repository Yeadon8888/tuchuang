import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('SQLite rejects late progress after cancellation and concurrent claim jobs for one assignee', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of ['0001_order_state.sql', '0003_claim_single_active.sql', '0004_claim_terminal_guard.sql']) {
      db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    const insert = db.prepare("INSERT INTO order_jobs(id,type,status,assignee,created_at,updated_at,expires_at) VALUES (?,'claim','processing','tester',0,0,1)");
    insert.run('one');
    assert.throws(() => insert.run('two'), /UNIQUE/);
    db.exec("UPDATE order_jobs SET status='failed' WHERE id='one'");
    assert.throws(() => db.exec("UPDATE order_jobs SET result='{}',message='late progress' WHERE id='one'"), /任务已经结束/);
    assert.throws(() => db.exec("UPDATE order_jobs SET status='completed',result='{}' WHERE id='one'"), /任务已经结束/);
    insert.run('two');
  } finally { db.close(); }
});

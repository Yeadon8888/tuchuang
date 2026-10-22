CREATE TABLE IF NOT EXISTS order_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee TEXT NOT NULL DEFAULT '',
  record_id TEXT NOT NULL DEFAULT '',
  lock_id TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '{}',
  message TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_jobs_request_id ON order_jobs(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_jobs_record_lock ON order_jobs(record_id, lock_id, status);
CREATE INDEX IF NOT EXISTS idx_order_jobs_expires ON order_jobs(expires_at);

CREATE TABLE IF NOT EXISTS order_upload_tickets (
  ticket TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  lock_id TEXT NOT NULL,
  assignee TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_upload_tickets_expires ON order_upload_tickets(expires_at);

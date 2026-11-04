CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_claim_per_assignee
ON order_jobs(assignee) WHERE type='claim' AND status='processing';

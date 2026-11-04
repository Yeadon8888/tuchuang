-- Reject late progress from a consumer still executing an obsolete Worker version.
-- Its next awaited checkpoint fails, stopping the old loop after its current record.
CREATE TRIGGER IF NOT EXISTS guard_terminal_claim_progress
BEFORE UPDATE OF result ON order_jobs
WHEN OLD.type='claim' AND OLD.status IN ('failed','completed')
BEGIN
  SELECT RAISE(ABORT, '接单任务已经结束，禁止旧执行继续写入');
END;

-- 고지서 분배 완료 시각 기록
ALTER TABLE utility_bills ADD COLUMN IF NOT EXISTS distributed_at timestamptz;

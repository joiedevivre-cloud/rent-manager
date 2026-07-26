-- ================================================================
-- notification_settings 생성 + notification_logs 컬럼 보완
--
-- notification_logs는 Supabase에 이미 아래 구조로 존재:
--   id, tenant_id, notification_type, template_content,
--   sent_at, status, error_message, aligo_message_id
-- 코드(NotificationModal, send_notifications)가 위 컬럼명을 그대로 사용하므로
-- CREATE TABLE을 하지 않고 누락 컬럼만 ADD COLUMN으로 추가함.
-- ================================================================

-- ── notification_settings ────────────────────────────────────────
-- 이미 존재하면 무시(IF NOT EXISTS), 없으면 생성
CREATE TABLE IF NOT EXISTS public.notification_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remind_days_before  INTEGER NOT NULL DEFAULT 3,
  overdue_days_after  INTEGER NOT NULL DEFAULT 1,
  sender_phone        TEXT,
  bank_account        TEXT,
  owner_name          TEXT,
  kakao_channel_id    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 단일 설정 행 보장
INSERT INTO public.notification_settings (id)
SELECT '00000000-0000-0000-0000-000000000001'
WHERE NOT EXISTS (SELECT 1 FROM public.notification_settings);

-- ── notification_logs — 기존 테이블에 누락 컬럼만 추가 ────────────
-- billing_month: 어느 청구월에 대한 발송인지 기록 (현재 코드는 메타 저장 용도)
ALTER TABLE public.notification_logs
  ADD COLUMN IF NOT EXISTS billing_month TEXT;

-- 기존에 잘못된 이름으로 인덱스가 생성됐을 경우 정리
DROP INDEX IF EXISTS public.idx_notification_logs_month;

-- 청구월 + 발송 유형으로 중복 발송 조회 시 사용
CREATE INDEX IF NOT EXISTS idx_notification_logs_billing_month
  ON public.notification_logs (billing_month, notification_type);

-- sent_at 기준 테넌트별 조회 인덱스 (NotificationHistory.jsx)
CREATE INDEX IF NOT EXISTS idx_notification_logs_tenant_sent
  ON public.notification_logs (tenant_id, sent_at DESC);

-- ── RLS ─────────────────────────────────────────────────────────
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_logs     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allowed users only" ON public.notification_settings;
CREATE POLICY "allowed users only" ON public.notification_settings
  FOR ALL USING (public.is_allowed_user());

DROP POLICY IF EXISTS "allowed users only" ON public.notification_logs;
CREATE POLICY "allowed users only" ON public.notification_logs
  FOR ALL USING (public.is_allowed_user());

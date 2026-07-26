-- ================================================================
-- RLS 정책: allowed_emails 기준으로 모든 주요 테이블 접근 제어
-- 선행 필수: 002b_rls_functions.sql 먼저 실행해야 is_allowed_user() 존재함
-- ================================================================

-- ── 1. RLS 활성화 ───────────────────────────────────────────────
ALTER TABLE public.tenants              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_charges      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.charge_details       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rent_history         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_types        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.utility_bills        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allowed_emails       ENABLE ROW LEVEL SECURITY;

-- ── 2. 정책 생성 (멱등: DROP → CREATE) ──────────────────────────

-- tenants
DROP POLICY IF EXISTS "allowed users only" ON public.tenants;
CREATE POLICY "allowed users only" ON public.tenants
  FOR ALL USING (is_allowed_user());

-- units
DROP POLICY IF EXISTS "allowed users only" ON public.units;
CREATE POLICY "allowed users only" ON public.units
  FOR ALL USING (is_allowed_user());

-- monthly_charges
DROP POLICY IF EXISTS "allowed users only" ON public.monthly_charges;
CREATE POLICY "allowed users only" ON public.monthly_charges
  FOR ALL USING (is_allowed_user());

-- charge_details
DROP POLICY IF EXISTS "allowed users only" ON public.charge_details;
CREATE POLICY "allowed users only" ON public.charge_details
  FOR ALL USING (is_allowed_user());

-- payment_history
DROP POLICY IF EXISTS "allowed users only" ON public.payment_history;
CREATE POLICY "allowed users only" ON public.payment_history
  FOR ALL USING (is_allowed_user());

-- rent_history
DROP POLICY IF EXISTS "allowed users only" ON public.rent_history;
CREATE POLICY "allowed users only" ON public.rent_history
  FOR ALL USING (is_allowed_user());

-- expense_types
DROP POLICY IF EXISTS "allowed users only" ON public.expense_types;
CREATE POLICY "allowed users only" ON public.expense_types
  FOR ALL USING (is_allowed_user());

-- utility_bills
DROP POLICY IF EXISTS "allowed users only" ON public.utility_bills;
CREATE POLICY "allowed users only" ON public.utility_bills
  FOR ALL USING (is_allowed_user());

-- notification_logs
DROP POLICY IF EXISTS "allowed users only" ON public.notification_logs;
CREATE POLICY "allowed users only" ON public.notification_logs
  FOR ALL USING (is_allowed_user());

-- notification_settings
DROP POLICY IF EXISTS "allowed users only" ON public.notification_settings;
CREATE POLICY "allowed users only" ON public.notification_settings
  FOR ALL USING (is_allowed_user());

-- allowed_emails: 자신의 레코드만 조회 가능
-- (is_allowed_user() 함수는 SECURITY DEFINER라 이 제약을 우회함 — 순환 없음)
DROP POLICY IF EXISTS "users can read own email" ON public.allowed_emails;
CREATE POLICY "users can read own email" ON public.allowed_emails
  FOR SELECT USING (email = auth.email());

-- ── 3. Edge Function (service role) 전용: RLS 우회 ──────────────
-- send_notifications, send_alimtalk은 SUPABASE_SERVICE_ROLE_KEY를 사용하므로
-- 별도 설정 없이 자동으로 RLS를 우회합니다.
-- 단, send_alimtalk은 DB를 직접 조회하지 않으므로 해당 없음.

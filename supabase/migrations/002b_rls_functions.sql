-- ================================================================
-- RLS 헬퍼 함수 — 003_rls_policies.sql 보다 반드시 먼저 실행
-- ================================================================

-- SECURITY DEFINER: 함수 내부에서 allowed_emails를 RLS 없이 조회하므로 순환 참조 없음
CREATE OR REPLACE FUNCTION public.is_allowed_user()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.allowed_emails WHERE email = auth.email()
  );
$$;

-- ── 배포 검증 쿼리 (실행 후 결과 확인) ──────────────────────────
-- 1. 함수 존재 확인
--    SELECT proname FROM pg_proc WHERE proname = 'is_allowed_user';
--    → 'is_allowed_user' 행이 반환돼야 함
--
-- 2. RLS 차단 확인 (허용되지 않은 이메일로 Supabase JS 클라이언트에서 실행):
--    const { data, error } = await supabase.from('tenants').select('id').limit(1)
--    → data가 [] 이거나 error.code === 'PGRST301' 이어야 함 (차단됨)
--
-- 3. 허용된 이메일로 로그인한 상태에서:
--    const { data } = await supabase.from('tenants').select('id').limit(1)
--    → 데이터가 정상 반환돼야 함

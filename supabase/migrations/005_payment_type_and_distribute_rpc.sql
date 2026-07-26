-- ================================================================
-- 1. payment_history.payment_type 컬럼 추가
-- 2. distribute_utility_bill() RPC 함수 (트랜잭션 보장)
-- ================================================================

-- ── 1. payment_type 컬럼 ─────────────────────────────────────────
ALTER TABLE public.payment_history
  ADD COLUMN IF NOT EXISTS payment_type TEXT;

-- ── 2. distribute_utility_bill RPC ───────────────────────────────
-- delete → insert → update 를 단일 트랜잭션으로 실행
-- 중간 실패 시 전체 롤백 보장
CREATE OR REPLACE FUNCTION public.distribute_utility_bill(p_bill_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill          public.utility_bills%ROWTYPE;
  v_total_res     BIGINT;
  v_per_person    BIGINT;
  v_remainder     BIGINT;
BEGIN
  -- 고지서 조회
  SELECT * INTO v_bill FROM public.utility_bills WHERE id = p_bill_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'BILL_NOT_FOUND');
  END IF;
  IF v_bill.distributed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_DISTRIBUTED');
  END IF;
  IF v_bill.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'BILL_CANCELLED');
  END IF;

  -- 해당 월 월세 거주인원 합계
  SELECT COALESCE(SUM(t.residents), 0) INTO v_total_res
  FROM public.monthly_charges mc
  JOIN public.tenants t ON t.id = mc.tenant_id
  WHERE mc.billing_month = v_bill.billed_month;

  IF v_total_res = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_RESIDENTS');
  END IF;

  v_per_person := FLOOR(v_bill.total_amount / v_total_res);
  v_remainder  := v_bill.total_amount - v_per_person * v_total_res;

  -- 기존 분배 내역 삭제 (재시도 대비)
  DELETE FROM public.charge_details WHERE source_bill_id = p_bill_id;

  -- 세입자별 분배 삽입 (거주인원 많은 순 → 첫 번째에 나머지 합산)
  INSERT INTO public.charge_details (charge_id, expense_type_code, amount, source_bill_id)
  SELECT
    mc.id,
    v_bill.expense_type_code,
    v_per_person * COALESCE(t.residents, 0)
      + CASE WHEN ROW_NUMBER() OVER (ORDER BY COALESCE(t.residents, 0) DESC) = 1
             THEN v_remainder ELSE 0 END,
    p_bill_id
  FROM public.monthly_charges mc
  JOIN public.tenants t ON t.id = mc.tenant_id
  WHERE mc.billing_month = v_bill.billed_month
    AND COALESCE(t.residents, 0) > 0;

  -- 분배 완료 기록
  UPDATE public.utility_bills
  SET distributed_at = now()
  WHERE id = p_bill_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- 일반 authenticated 유저가 RPC 호출 가능하도록 권한 부여
GRANT EXECUTE ON FUNCTION public.distribute_utility_bill(UUID) TO authenticated;

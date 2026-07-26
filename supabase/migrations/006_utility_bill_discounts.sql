-- ================================================================
-- 세대별 고지서 감면 지원 (예: 다자녀 수도세 감면)
-- 1. utility_bill_discounts 테이블 추가 — 고지서별 · 세대별 감면액 기록
-- 2. distribute_utility_bill()이 인원수 균등분배 후 감면액을 해당 세대에서만 차감하도록 수정
-- ================================================================

CREATE TABLE public.utility_bill_discounts (
  id          uuid primary key default gen_random_uuid(),
  bill_id     uuid not null references public.utility_bills(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  amount      numeric(12,0) not null check (amount > 0),
  reason      text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz default now(),
  unique (bill_id, tenant_id)
);

ALTER TABLE public.utility_bill_discounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bill_discounts_all" ON public.utility_bill_discounts FOR ALL USING (is_allowed_user());

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

  SELECT COALESCE(SUM(t.residents), 0) INTO v_total_res
  FROM public.monthly_charges mc
  JOIN public.tenants t ON t.id = mc.tenant_id
  WHERE mc.billing_month = v_bill.billed_month;

  IF v_total_res = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'NO_RESIDENTS');
  END IF;

  v_per_person := FLOOR(v_bill.total_amount / v_total_res);
  v_remainder  := v_bill.total_amount - v_per_person * v_total_res;

  DELETE FROM public.charge_details WHERE source_bill_id = p_bill_id;

  -- 인원수 기준 균등분배 금액에서, 감면 대상 세대만 utility_bill_discounts.amount 만큼 차감
  -- (다른 세대 분담금에는 영향 없음 — 감면분은 임대인이 부담)
  INSERT INTO public.charge_details (charge_id, expense_type_code, amount, source_bill_id)
  SELECT
    mc.id,
    v_bill.expense_type_code,
    GREATEST(
      0,
      v_per_person * COALESCE(t.residents, 0)
        + CASE WHEN ROW_NUMBER() OVER (ORDER BY COALESCE(t.residents, 0) DESC) = 1
               THEN v_remainder ELSE 0 END
        - COALESCE(bd.amount, 0)
    ),
    p_bill_id
  FROM public.monthly_charges mc
  JOIN public.tenants t ON t.id = mc.tenant_id
  LEFT JOIN public.utility_bill_discounts bd ON bd.bill_id = p_bill_id AND bd.tenant_id = t.id
  WHERE mc.billing_month = v_bill.billed_month
    AND COALESCE(t.residents, 0) > 0;

  UPDATE public.utility_bills
  SET distributed_at = now()
  WHERE id = p_bill_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.distribute_utility_bill(UUID) TO authenticated;

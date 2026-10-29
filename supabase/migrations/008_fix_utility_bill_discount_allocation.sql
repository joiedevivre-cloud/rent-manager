-- Fix household-specific discount allocation.
-- Allocate the pre-discount total, then subtract each household discount.
-- The final household charge sum must equal the payable bill total.

CREATE OR REPLACE FUNCTION public.distribute_utility_bill(p_bill_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill              public.utility_bills%ROWTYPE;
  v_total_res         BIGINT;
  v_per_person        BIGINT;
  v_remainder         BIGINT;
  v_total_weight      NUMERIC;
  v_total_discount    NUMERIC := 0;
  v_distribution_total NUMERIC;
  v_charged_total     NUMERIC;
  v_credit_results    JSONB := '[]'::jsonb;
  rec                 RECORD;
  v_balance           NUMERIC;
  v_reservation_id    UUID;
  v_reserved_remaining NUMERIC;
  v_move_out_snapshot DATE;
  v_apply             NUMERIC;
  v_payment_id        UUID;
  v_caused_release     BOOLEAN;
  v_refund_credit_id  UUID;
BEGIN
  SELECT * INTO v_bill FROM public.utility_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'BILL_NOT_FOUND');
  END IF;
  IF v_bill.distributed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_DISTRIBUTED');
  END IF;
  IF v_bill.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'BILL_CANCELLED');
  END IF;

  -- 고지서 total_amount는 세대 전용 감면이 이미 반영된 실제 납부액이다.
  -- 감면액을 다시 더한 금액을 배분한 뒤 해당 세대에서 감면해야 최종 합계가 고지액과 일치한다.
  SELECT COALESCE(SUM(amount), 0)
  INTO v_total_discount
  FROM public.utility_bill_discounts
  WHERE bill_id = p_bill_id;

  v_distribution_total := v_bill.total_amount + v_total_discount;

  IF v_bill.expense_type_code = 'WATER' THEN
    ------------------------------------------------------------
    -- WATER: 거주일수 가중 통합 배분
    ------------------------------------------------------------
    IF v_bill.period_start IS NULL OR v_bill.period_end IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'PERIOD_REQUIRED');
    END IF;

    SELECT COALESCE(SUM(
      t.residents * (
        LEAST(COALESCE(t.move_out_date, v_bill.period_end), v_bill.period_end)
        - GREATEST(t.move_in_date, v_bill.period_start) + 1
      )
    ), 0) INTO v_total_weight
    FROM public.tenants t
    WHERE t.move_in_date IS NOT NULL
      AND t.move_in_date <= v_bill.period_end
      AND (t.move_out_date IS NULL OR t.move_out_date >= v_bill.period_start)
      AND (
        LEAST(COALESCE(t.move_out_date, v_bill.period_end), v_bill.period_end)
        - GREATEST(t.move_in_date, v_bill.period_start) + 1
      ) > 0;

    IF v_total_weight <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'NO_RESIDENTS');
    END IF;

    -- 겹치는 세입자에 monthly_charges 보장 (이미 있으면 무시)
    INSERT INTO public.monthly_charges (tenant_id, billing_month)
    SELECT t.id, v_bill.billed_month
    FROM public.tenants t
    WHERE t.move_in_date IS NOT NULL
      AND t.move_in_date <= v_bill.period_end
      AND (t.move_out_date IS NULL OR t.move_out_date >= v_bill.period_start)
      AND (
        LEAST(COALESCE(t.move_out_date, v_bill.period_end), v_bill.period_end)
        - GREATEST(t.move_in_date, v_bill.period_start) + 1
      ) > 0
    ON CONFLICT (tenant_id, billing_month) DO NOTHING;

    -- 기존 분배 내역 삭제 (재시도 대비 — 006과 동일한 idempotent 패턴)
    DELETE FROM public.charge_details WHERE source_bill_id = p_bill_id;

    -- Hamilton 최대잉여법: sum(final) = total_amount를 항상 보장하는 결정적 반올림
    INSERT INTO public.charge_details (charge_id, expense_type_code, amount, source_bill_id)
    WITH overlap AS (
      SELECT
        t.id AS tenant_id,
        t.residents * (
          LEAST(COALESCE(t.move_out_date, v_bill.period_end), v_bill.period_end)
          - GREATEST(t.move_in_date, v_bill.period_start) + 1
        ) AS weight
      FROM public.tenants t
      WHERE t.move_in_date IS NOT NULL
        AND t.move_in_date <= v_bill.period_end
        AND (t.move_out_date IS NULL OR t.move_out_date >= v_bill.period_start)
        AND (
          LEAST(COALESCE(t.move_out_date, v_bill.period_end), v_bill.period_end)
          - GREATEST(t.move_in_date, v_bill.period_start) + 1
        ) > 0
    ),
    weighted AS (
      SELECT
        tenant_id,
        FLOOR(v_distribution_total * weight / v_total_weight) AS floor_amt,
        (v_distribution_total * weight / v_total_weight)
          - FLOOR(v_distribution_total * weight / v_total_weight) AS frac
      FROM overlap
    ),
    ranked AS (
      SELECT
        tenant_id, floor_amt,
        ROW_NUMBER() OVER (ORDER BY frac DESC, tenant_id ASC) AS rnk,
        SUM(floor_amt) OVER () AS total_floor
      FROM weighted
    ),
    final AS (
      SELECT
        tenant_id,
        (floor_amt + CASE WHEN rnk <= (v_distribution_total - total_floor) THEN 1 ELSE 0 END)::numeric(12,0) AS amount
      FROM ranked
    )
    SELECT
      mc.id,
      v_bill.expense_type_code,
      GREATEST(0, f.amount - COALESCE(bd.amount, 0)),
      p_bill_id
    FROM final f
    JOIN public.monthly_charges mc ON mc.tenant_id = f.tenant_id AND mc.billing_month = v_bill.billed_month
    LEFT JOIN public.utility_bill_discounts bd ON bd.bill_id = p_bill_id AND bd.tenant_id = f.tenant_id;

    SELECT COALESCE(SUM(amount), 0) INTO v_charged_total
    FROM public.charge_details WHERE source_bill_id = p_bill_id;
    IF v_charged_total <> v_bill.total_amount THEN
      RAISE EXCEPTION 'DISTRIBUTION_TOTAL_MISMATCH: expected %, got %',
        v_bill.total_amount, v_charged_total;
    END IF;

    -- 자동 충당: 방금 만든 각 WATER charge_details 행에 대해 (예약 있으면 예약분, 없으면 가용잔액)
    FOR rec IN
      SELECT cd.charge_id, cd.amount AS charge_amount, mc.tenant_id
      FROM public.charge_details cd
      JOIN public.monthly_charges mc ON mc.id = cd.charge_id
      WHERE cd.source_bill_id = p_bill_id AND cd.amount > 0
    LOOP
      PERFORM pg_advisory_xact_lock(hashtext(rec.tenant_id::text)::bigint);
      -- hashtext는 32bit 해시라 이론상 충돌 가능하지만, 다른 세입자와 우연히 같은 락을 잡아도
      -- 과도한 직렬화만 유발할 뿐 잔액 정합성에는 영향 없음.

      v_reservation_id := NULL;
      SELECT id INTO v_reservation_id
      FROM public.tenant_water_credit_reservations
      WHERE tenant_id = rec.tenant_id AND released_at IS NULL
      LIMIT 1;

      IF v_reservation_id IS NOT NULL THEN
        SELECT r.amount - COALESCE((
          SELECT SUM(u.amount) FROM public.tenant_water_credit_usages u
          WHERE u.reservation_id = r.id AND u.reversed_at IS NULL
        ), 0), r.move_out_date_snapshot
        INTO v_reserved_remaining, v_move_out_snapshot
        FROM public.tenant_water_credit_reservations r WHERE r.id = v_reservation_id;
        v_balance := GREATEST(0, v_reserved_remaining);
      ELSE
        SELECT COALESCE((
          SELECT SUM(amount) FROM public.tenant_water_credits
          WHERE tenant_id = rec.tenant_id AND reversed_at IS NULL
        ), 0) - COALESCE((
          SELECT SUM(amount) FROM public.tenant_water_credit_usages
          WHERE tenant_id = rec.tenant_id AND reversed_at IS NULL
        ), 0) INTO v_balance;
        v_balance := GREATEST(0, v_balance);
      END IF;

      IF v_balance <= 0 THEN
        CONTINUE; -- 선납금 없으면 기존 동작 그대로 (미수금으로 남음, 아무것도 안 함)
      END IF;

      v_apply := LEAST(v_balance, rec.charge_amount);
      v_caused_release := false;
      v_refund_credit_id := NULL;

      INSERT INTO public.payment_history (charge_id, payment_date, amount, memo, payment_type, created_by)
      VALUES (rec.charge_id, CURRENT_DATE, v_apply, '[수도세]선납금 자동충당', 'WATER', auth.uid())
      RETURNING id INTO v_payment_id;

      IF v_reservation_id IS NOT NULL THEN
        v_reserved_remaining := v_reserved_remaining - v_apply;
        IF v_reserved_remaining <= 0 OR v_bill.period_end >= v_move_out_snapshot THEN
          v_caused_release := true;
          IF v_reserved_remaining > 0 THEN
            INSERT INTO public.tenant_water_credits (tenant_id, entry_type, amount, memo, deposit_date, created_by)
            VALUES (rec.tenant_id, 'REFUND', -v_reserved_remaining, '수도세 정산 완료 - 잔여 환급', CURRENT_DATE, auth.uid())
            RETURNING id INTO v_refund_credit_id;
          END IF;
          UPDATE public.tenant_water_credit_reservations
          SET released_at = now(), released_reason = 'SETTLED'
          WHERE id = v_reservation_id;
        END IF;
      END IF;

      INSERT INTO public.tenant_water_credit_usages
        (tenant_id, bill_id, charge_id, amount, payment_id, reservation_id,
         caused_reservation_release, refund_credit_id, created_by)
      VALUES
        (rec.tenant_id, p_bill_id, rec.charge_id, v_apply, v_payment_id, v_reservation_id,
         v_caused_release, v_refund_credit_id, auth.uid());

      v_credit_results := v_credit_results || jsonb_build_object(
        'tenant_id', rec.tenant_id,
        'applied', v_apply,
        'from_reservation', v_reservation_id IS NOT NULL,
        'reservation_settled', v_caused_release,
        'shortfall', GREATEST(0, rec.charge_amount - v_apply)
      );
    END LOOP;

    UPDATE public.utility_bills SET distributed_at = now() WHERE id = p_bill_id;
    RETURN jsonb_build_object('success', true, 'credit_usage', v_credit_results);

  ELSE
    ------------------------------------------------------------
    -- 기존 로직 (WATER 외 전 항목) — 006과 완전히 동일, 변경 없음
    ------------------------------------------------------------
    SELECT COALESCE(SUM(t.residents), 0) INTO v_total_res
    FROM public.monthly_charges mc
    JOIN public.tenants t ON t.id = mc.tenant_id
    WHERE mc.billing_month = v_bill.billed_month;

    IF v_total_res = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'NO_RESIDENTS');
    END IF;

    v_per_person := FLOOR(v_distribution_total / v_total_res);
    v_remainder  := v_distribution_total - v_per_person * v_total_res;

    DELETE FROM public.charge_details WHERE source_bill_id = p_bill_id;

    INSERT INTO public.charge_details (charge_id, expense_type_code, amount, source_bill_id)
    SELECT
      mc.id,
      v_bill.expense_type_code,
      GREATEST(0,
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

    SELECT COALESCE(SUM(amount), 0) INTO v_charged_total
    FROM public.charge_details WHERE source_bill_id = p_bill_id;
    IF v_charged_total <> v_bill.total_amount THEN
      RAISE EXCEPTION 'DISTRIBUTION_TOTAL_MISMATCH: expected %, got %',
        v_bill.total_amount, v_charged_total;
    END IF;

    UPDATE public.utility_bills SET distributed_at = now() WHERE id = p_bill_id;
    RETURN jsonb_build_object('success', true);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.distribute_utility_bill(UUID) TO authenticated;

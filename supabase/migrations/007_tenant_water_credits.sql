-- ================================================================
-- 세입자별 수도세 선납금 + 퇴거 정산(예약) 기능
--
-- 1. tenant_water_credits            — 선납금 입금/조정/환급 원장 (soft-cancel, 하드 삭제 없음)
-- 2. tenant_water_credit_reservations — 퇴거 시 "즉시환급하지 않고 보류"한 금액 잠금
-- 3. tenant_water_credit_usages       — 선납금이 어느 고지서·청구에 얼마 쓰였는지 (일반/예약 공용)
-- 4. tenant_water_credit_balances 뷰  — 총잔액/예약잔액/가용잔액 (캐시 없이 원장 합계로 계산)
-- 5. distribute_utility_bill() 재작성 — WATER는 거주일수 가중 통합배분(현재+퇴거+신규입주 전체)
--    + 자동 선납금 충당. WATER가 아닌 항목(SEPTIC 등)은 006의 기존 인원수 균등분배 그대로 유지.
-- 6. cancel_utility_bill_distribution() 신규 — 배분/선납충당/퇴거정산/환급을 역순으로 원복
-- 7. process_tenant_move_out() 신규 — 퇴거 처리(보증금 정산 + 즉시환급/보류 분리)를 원자적으로 처리
--
-- 뷰는 RLS를 별도로 걸지 않는다 — Postgres 뷰는 기본적으로 조회자 권한으로 base table의 RLS를
-- 그대로 적용하므로(security_invoker 관례), 아래 3개 테이블에 RLS를 걸면 뷰도 자동으로 안전하다.
-- ================================================================

-- ── 1. 선납금 입금/조정/환급 원장 ─────────────────────────────────
CREATE TABLE public.tenant_water_credits (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  entry_type   text not null check (entry_type in ('DEPOSIT','ADJUSTMENT','REFUND')),
  amount       numeric(12,0) not null,
  memo         text,
  deposit_date date not null default current_date,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz default now(),
  reversed_at  timestamptz,
  reversed_by  uuid references public.profiles(id),
  check (
    (entry_type = 'DEPOSIT'    and amount > 0) or
    (entry_type = 'REFUND'     and amount < 0) or
    (entry_type = 'ADJUSTMENT' and amount <> 0)
  )
);
CREATE INDEX idx_water_credits_tenant ON public.tenant_water_credits(tenant_id);

-- ── 2. 퇴거 시 보류(예약)된 금액 ──────────────────────────────────
CREATE TABLE public.tenant_water_credit_reservations (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  amount                 numeric(12,0) not null check (amount > 0), -- 예약 당시 고정(불변)
  residents_snapshot     int not null,       -- 감사·표시용 스냅샷 — 배분 계산에는 안 씀
  move_out_date_snapshot date not null,
  refund_account         text,
  refund_memo            text,
  deposit_return_id      uuid references public.deposit_returns(id),
  created_by             uuid references public.profiles(id),
  created_at             timestamptz default now(),
  released_at            timestamptz,
  released_reason        text
);
CREATE INDEX idx_water_reservations_tenant ON public.tenant_water_credit_reservations(tenant_id);
-- 세입자당 활성(미종료) 예약은 동시에 1건만 — 퇴거 중복 처리 방지
CREATE UNIQUE INDEX idx_water_reservations_active_unique
  ON public.tenant_water_credit_reservations(tenant_id) WHERE released_at IS NULL;

-- ── 3. 선납금 사용 원장 (일반 잔액 충당 + 예약 잔액 충당 공용) ──────
CREATE TABLE public.tenant_water_credit_usages (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references public.tenants(id) on delete cascade,
  bill_id                     uuid not null references public.utility_bills(id) on delete cascade,
  charge_id                   uuid not null references public.monthly_charges(id) on delete cascade,
  amount                      numeric(12,0) not null check (amount > 0),
  payment_id                  uuid references public.payment_history(id),
  reservation_id              uuid references public.tenant_water_credit_reservations(id),
  caused_reservation_release  boolean not null default false, -- 이 사용이 예약을 최종 종료시켰는지
  refund_credit_id            uuid references public.tenant_water_credits(id), -- 종료 시 생긴 최종 환급 row
  created_by                  uuid references public.profiles(id),
  created_at                  timestamptz default now(),
  reversed_at                 timestamptz,
  reversed_by                 uuid references public.profiles(id)
);
-- 같은 고지서·세입자 조합에 활성 사용 내역이 2개 생길 수 없음 — 중복 충당(멱등성) 방지의 핵심
CREATE UNIQUE INDEX idx_credit_usage_unique_active
  ON public.tenant_water_credit_usages(bill_id, tenant_id) WHERE reversed_at IS NULL;
CREATE UNIQUE INDEX idx_credit_usage_payment_unique
  ON public.tenant_water_credit_usages(payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX idx_credit_usages_tenant ON public.tenant_water_credit_usages(tenant_id);
CREATE INDEX idx_credit_usages_bill ON public.tenant_water_credit_usages(bill_id);
CREATE INDEX idx_credit_usages_reservation ON public.tenant_water_credit_usages(reservation_id);

-- ── 4. 잔액 뷰 (총잔액 / 예약잔액 / 가용잔액) ──────────────────────
CREATE VIEW public.tenant_water_credit_balances AS
SELECT
  t.id AS tenant_id,
  COALESCE(c.total, 0) - COALESCE(u.total, 0) AS total_balance,
  COALESCE(r.reserved, 0) AS reserved_balance,
  COALESCE(c.total, 0) - COALESCE(u.total, 0) - COALESCE(r.reserved, 0) AS available_balance
FROM public.tenants t
LEFT JOIN (
  SELECT tenant_id, SUM(amount) AS total
  FROM public.tenant_water_credits WHERE reversed_at IS NULL
  GROUP BY tenant_id
) c ON c.tenant_id = t.id
LEFT JOIN (
  SELECT tenant_id, SUM(amount) AS total
  FROM public.tenant_water_credit_usages WHERE reversed_at IS NULL
  GROUP BY tenant_id
) u ON u.tenant_id = t.id
LEFT JOIN (
  SELECT res.tenant_id, SUM(res.amount - COALESCE(used.total, 0)) AS reserved
  FROM public.tenant_water_credit_reservations res
  LEFT JOIN (
    SELECT reservation_id, SUM(amount) AS total
    FROM public.tenant_water_credit_usages
    WHERE reversed_at IS NULL AND reservation_id IS NOT NULL
    GROUP BY reservation_id
  ) used ON used.reservation_id = res.id
  WHERE res.released_at IS NULL
  GROUP BY res.tenant_id
) r ON r.tenant_id = t.id;

-- ── RLS ───────────────────────────────────────────────────────────
ALTER TABLE public.tenant_water_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_water_credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_water_credit_usages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "water_credits_all" ON public.tenant_water_credits FOR ALL USING (public.is_allowed_user());
CREATE POLICY "water_reservations_all" ON public.tenant_water_credit_reservations FOR ALL USING (public.is_allowed_user());
CREATE POLICY "water_credit_usages_all" ON public.tenant_water_credit_usages FOR ALL USING (public.is_allowed_user());

-- ================================================================
-- distribute_utility_bill() 재작성
--   WATER: 고지서 사용기간(period_start~period_end)과 거주기간이 겹치는 모든 세입자
--          (현재 재적 여부 무관, 퇴거자·신규입주자 포함)를 대상으로
--          '거주인원 × 겹치는 거주일수'를 가중치로 Hamilton 최대잉여법으로 total_amount를
--          정확히 나눈다. 분배 후 각자의 선납금(예약 있으면 예약분, 없으면 일반 가용잔액)에서
--          자동 충당한다.
--   그 외 항목(SEPTIC 등): 006의 기존 인원수 균등분배 로직 100% 동일 유지.
-- ================================================================
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
        FLOOR(v_bill.total_amount::numeric * weight / v_total_weight) AS floor_amt,
        (v_bill.total_amount::numeric * weight / v_total_weight)
          - FLOOR(v_bill.total_amount::numeric * weight / v_total_weight) AS frac
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
        (floor_amt + CASE WHEN rnk <= (v_bill.total_amount - total_floor) THEN 1 ELSE 0 END)::numeric(12,0) AS amount
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

    v_per_person := FLOOR(v_bill.total_amount / v_total_res);
    v_remainder  := v_bill.total_amount - v_per_person * v_total_res;

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

    UPDATE public.utility_bills SET distributed_at = now() WHERE id = p_bill_id;
    RETURN jsonb_build_object('success', true);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.distribute_utility_bill(UUID) TO authenticated;

-- ================================================================
-- cancel_utility_bill_distribution() — 배분 취소를 단일 트랜잭션으로
--   기존 cancelBill()의 2단계 순차 client 호출(update + delete)을 대체.
--   WATER가 아닌 고지서는 아래 ②③④단계에서 아무 행도 안 걸려 기존 취소 동작과 100% 동일.
--   역순 복원: ④환급 되돌리기 → ③예약 재오픈 → ②선납금사용/납부 되돌리기 → ①배분 삭제
-- ================================================================
CREATE OR REPLACE FUNCTION public.cancel_utility_bill_distribution(p_bill_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill public.utility_bills%ROWTYPE;
  rec RECORD;
BEGIN
  SELECT * INTO v_bill FROM public.utility_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'BILL_NOT_FOUND');
  END IF;
  IF v_bill.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_CANCELLED');
  END IF;

  FOR rec IN
    SELECT DISTINCT tenant_id FROM public.tenant_water_credit_usages WHERE bill_id = p_bill_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(rec.tenant_id::text)::bigint);
  END LOOP;

  -- 안전장치: 이 고지서가 종료시킨 게 아닌, 이미 종료된 예약을 건드리고 있으면 취소 거부
  -- (더 최근의 다른 고지서가 이 예약을 이미 최종 정산했다는 뜻 — 역순으로 그 고지서부터 취소해야 함)
  IF EXISTS (
    SELECT 1
    FROM public.tenant_water_credit_usages u
    JOIN public.tenant_water_credit_reservations r ON r.id = u.reservation_id
    WHERE u.bill_id = p_bill_id AND u.reversed_at IS NULL AND u.reservation_id IS NOT NULL
      AND r.released_at IS NOT NULL AND NOT u.caused_reservation_release
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'RESERVATION_ALREADY_SETTLED_BY_LATER_BILL');
  END IF;

  -- ④ 이 고지서가 만든 최종 환급 되돌리기
  UPDATE public.tenant_water_credits
  SET reversed_at = now(), reversed_by = auth.uid()
  WHERE reversed_at IS NULL
    AND id IN (
      SELECT refund_credit_id FROM public.tenant_water_credit_usages
      WHERE bill_id = p_bill_id AND reversed_at IS NULL AND refund_credit_id IS NOT NULL
    );

  -- ③ 이 고지서가 종료시킨 예약 재오픈
  UPDATE public.tenant_water_credit_reservations
  SET released_at = NULL, released_reason = NULL
  WHERE id IN (
    SELECT reservation_id FROM public.tenant_water_credit_usages
    WHERE bill_id = p_bill_id AND reversed_at IS NULL AND caused_reservation_release
  );

  -- ② 선납금 사용/자동납부 되돌리기 (사람이 이미 수동 취소했어도 안전하도록 독립적 가드)
  UPDATE public.payment_history
  SET reversed_at = now(), reversed_by = auth.uid()
  WHERE reversed_at IS NULL
    AND id IN (
      SELECT payment_id FROM public.tenant_water_credit_usages
      WHERE bill_id = p_bill_id AND reversed_at IS NULL AND payment_id IS NOT NULL
    );

  UPDATE public.tenant_water_credit_usages
  SET reversed_at = now(), reversed_by = auth.uid()
  WHERE bill_id = p_bill_id AND reversed_at IS NULL;

  -- ① 배분 삭제 (기존 취소 동작과 동일)
  DELETE FROM public.charge_details WHERE source_bill_id = p_bill_id;

  UPDATE public.utility_bills
  SET cancelled_at = now(), cancelled_by = auth.uid()
  WHERE id = p_bill_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_utility_bill_distribution(UUID) TO authenticated;

-- ================================================================
-- process_tenant_move_out() — 퇴거 처리를 단일 트랜잭션으로
--   기존 saveTenantReplacement()의 2단계 순차 client 호출(tenants.update + deposit_returns.insert)
--   을 대체. 즉시환급 + 보류(예약)액 = 현재 가용잔액이어야 함을 검증.
-- ================================================================
CREATE OR REPLACE FUNCTION public.process_tenant_move_out(
  p_tenant_id        UUID,
  p_move_out_date    DATE,
  p_deposit_amount   NUMERIC,
  p_deducted_amount  NUMERIC,
  p_deposit_memo     TEXT,
  p_immediate_refund NUMERIC,
  p_reserved_amount  NUMERIC,
  p_refund_account   TEXT,
  p_refund_memo      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant            public.tenants%ROWTYPE;
  v_balance           NUMERIC;
  v_deposit_return_id UUID;
  v_reservation_id    UUID;
BEGIN
  SELECT * INTO v_tenant FROM public.tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TENANT_NOT_FOUND');
  END IF;
  IF v_tenant.move_out_date IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_MOVED_OUT');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_tenant_id::text)::bigint);

  SELECT COALESCE((
    SELECT SUM(amount) FROM public.tenant_water_credits
    WHERE tenant_id = p_tenant_id AND reversed_at IS NULL
  ), 0) - COALESCE((
    SELECT SUM(amount) FROM public.tenant_water_credit_usages
    WHERE tenant_id = p_tenant_id AND reversed_at IS NULL
  ), 0) INTO v_balance;

  IF COALESCE(p_immediate_refund, 0) + COALESCE(p_reserved_amount, 0) <> v_balance THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'AMOUNT_MISMATCH', 'current_balance', v_balance
    );
  END IF;

  INSERT INTO public.deposit_returns (tenant_id, return_date, deposit_amount, deducted_amount, memo, created_by)
  VALUES (p_tenant_id, p_move_out_date, p_deposit_amount, p_deducted_amount, p_deposit_memo, auth.uid())
  RETURNING id INTO v_deposit_return_id;

  IF COALESCE(p_immediate_refund, 0) > 0 THEN
    INSERT INTO public.tenant_water_credits (tenant_id, entry_type, amount, memo, deposit_date, created_by)
    VALUES (p_tenant_id, 'REFUND', -p_immediate_refund, '퇴거 즉시환급', p_move_out_date, auth.uid());
  END IF;

  IF COALESCE(p_reserved_amount, 0) > 0 THEN
    INSERT INTO public.tenant_water_credit_reservations
      (tenant_id, amount, residents_snapshot, move_out_date_snapshot,
       refund_account, refund_memo, deposit_return_id, created_by)
    VALUES
      (p_tenant_id, p_reserved_amount, v_tenant.residents, p_move_out_date,
       p_refund_account, p_refund_memo, v_deposit_return_id, auth.uid())
    RETURNING id INTO v_reservation_id;
  END IF;

  UPDATE public.tenants SET move_out_date = p_move_out_date WHERE id = p_tenant_id;

  RETURN jsonb_build_object(
    'success', true,
    'deposit_return_id', v_deposit_return_id,
    'reservation_id', v_reservation_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_tenant_move_out(
  UUID, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, TEXT
) TO authenticated;

// Supabase Edge Function: send_notifications
// 스케줄: "0 0 * * *" (UTC 00:00 = KST 09:00)
//
// 배포 방법:
//   supabase functions deploy send_notifications --no-verify-jwt
//
// 스케줄 등록 (Supabase Dashboard → Database → Extensions → pg_cron):
//   select cron.schedule('send_notifications', '0 0 * * *',
//     $$select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/send_notifications',
//       headers := '{"Authorization":"Bearer <service-role-key>"}'::jsonb
//     )$$
//   );

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALIGO_API_KEY   = Deno.env.get('ALIGO_API_KEY') ?? ''
const ALIGO_USER_ID   = Deno.env.get('ALIGO_USER_ID') ?? ''
const ALIGO_SENDER    = Deno.env.get('ALIGO_SENDER') ?? ''
const KAKAO_CHANNEL_ID = Deno.env.get('KAKAO_CHANNEL_ID') ?? ''
const ALIGO_TPL_PAYMENT = Deno.env.get('ALIGO_TPL_PAYMENT_REMIND') ?? ''
const ALIGO_TPL_OVERDUE = Deno.env.get('ALIGO_TPL_OVERDUE') ?? ''
const HOLIDAY_API_KEY = Deno.env.get('HOLIDAY_API_KEY') ?? ''

// ── 공휴일 체크 ─────────────────────────────────────────
async function fetchKoreanHolidays(year: number, month: number): Promise<string[]> {
  try {
    const mm = String(month).padStart(2, '0')
    const url = `http://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo?solYear=${year}&solMonth=${mm}&ServiceKey=${encodeURIComponent(HOLIDAY_API_KEY)}&_type=json&numOfRows=30`
    const res = await fetch(url)
    const json = await res.json()
    const items = json?.response?.body?.items?.item
    if (!items) return []
    const arr = Array.isArray(items) ? items : [items]
    return arr.map((i: any) => String(i.locdate))
  } catch {
    return [] // fallback: API 실패 시 빈 배열 → 토/일만 체크
  }
}

function isWeekend(date: Date): boolean {
  const d = date.getDay()
  return d === 0 || d === 6
}

function isHolidayDate(dateStr: string, holidays: string[]): boolean {
  return holidays.includes(dateStr.replace(/-/g, ''))
}

function isHolidayOrWeekend(date: Date, holidays: string[]): boolean {
  const str = date.toISOString().slice(0, 10)
  return isWeekend(date) || isHolidayDate(str, holidays)
}

// 납부일이 휴일이면 다음 영업일로 보정 (민법 제161조)
function getActualDueDate(year: number, month: number, paymentDay: number, holidays: string[]): Date {
  const due = new Date(year, month - 1, paymentDay)
  while (isHolidayOrWeekend(due, holidays)) {
    due.setDate(due.getDate() + 1)
  }
  return due
}

// ── 알리고 알림톡 발송 ──────────────────────────────────
async function sendAlimtalk(phone: string, message: string, notifType: string): Promise<string> {
  const form = new FormData()
  form.append('apikey', ALIGO_API_KEY)
  form.append('userid', ALIGO_USER_ID)
  form.append('senderkey', KAKAO_CHANNEL_ID)
  form.append('tpl_code', notifType === 'PAYMENT_REMIND' ? ALIGO_TPL_PAYMENT : ALIGO_TPL_OVERDUE)
  form.append('sender', ALIGO_SENDER)
  form.append('receiver_1', phone.replace(/[^0-9]/g, ''))
  form.append('subject_1', notifType === 'PAYMENT_REMIND' ? '임대료 납부 안내' : '임대료 연체 안내')
  form.append('message_1', message)

  const res = await fetch('https://kakaoapi.aligo.in/akv10/alimtalk/send/', { method: 'POST', body: form })
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.message || '알리고 오류')
  return data?.mid?.toString() ?? ''
}

// ── 메시지 빌더 ─────────────────────────────────────────
function fmtNum(n: number) {
  return n.toLocaleString('ko-KR')
}

function buildPaymentRemind(tenant: any, charge: any, details: any[], settings: any, daysUntil: number): string {
  const lines = [
    `${tenant.name}님, 안녕하세요.`,
    `${tenant.units?.unit_no} 이번 달 임대료 납부일(${tenant.payment_day}일)이`,
    `${daysUntil}일 후입니다.`,
    '',
    `청구액: ${fmtNum(Number(charge.total_amount))}원`,
  ]
  const rent = details.find((d: any) => d.expense_type_code === 'RENT')
  const water = details.find((d: any) => d.expense_type_code === 'WATER')
  if (rent) lines.push(`  - 월세: ${fmtNum(Number(rent.amount))}원`)
  if (water) lines.push(`  - 수도세: ${fmtNum(Number(water.amount))}원`)
  lines.push('', `납부 계좌: ${settings?.bank_account || '(미설정)'}`, `문의: ${settings?.sender_phone || '(미설정)'}`)
  return lines.join('\n')
}

function buildOverdue(tenant: any, charges: any[], detailsMap: Record<string, any[]>, settings: any): string {
  const total = charges.reduce((s: number, c: any) => s + Number(c.outstanding), 0)
  const lines = [
    `안녕하세요, ${tenant.name}님.`,
    '',
    `${tenant.units?.unit_no} 임대료 납부일(${tenant.payment_day}일)이 지나 안내드립니다.`,
    '',
    `현재 미납 금액은 ${fmtNum(total)}원입니다.`,
    '',
  ]
  for (const c of charges) {
    lines.push(`• ${c.billing_month.slice(0, 7)} : ${fmtNum(Number(c.outstanding))}원`)
    for (const item of (detailsMap[c.id] || [])) {
      if (Number(item.amount) > 0) lines.push(`  - ${(item as any).expense_types?.label || item.expense_type_code}: ${fmtNum(Number(item.amount))}원`)
    }
  }
  lines.push('')
  if (settings?.bank_account) lines.push(`납부 계좌: ${settings.bank_account}`)
  lines.push('혹시 이미 송금하셨다면 이 문자는 무시해 주세요.')
  lines.push(settings?.owner_name ? `감사합니다. - ${settings.owner_name}` : '감사합니다.')
  return lines.join('\n')
}

// ── 메인 핸들러 ─────────────────────────────────────────
serve(async () => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )

  // KST 기준 현재 날짜 계산
  const now = new Date()
  const kstOffset = 9 * 60 * 60 * 1000
  const kstNow = new Date(now.getTime() + kstOffset)
  const today = kstNow.toISOString().split('T')[0]         // 'YYYY-MM-DD'
  const todayDay = kstNow.getDate()
  const kstYear = kstNow.getFullYear()
  const kstMonth = kstNow.getMonth() + 1
  const currentBillingMonth = `${kstYear}-${String(kstMonth).padStart(2, '0')}-01`

  console.log(`실행 시간 - UTC: ${now.toISOString()}, KST: ${kstNow.toISOString()}`)

  // 공휴일 조회 (이번 달)
  const holidays = await fetchKoreanHolidays(kstYear, kstMonth)
  console.log(`공휴일 목록 (${kstYear}-${kstMonth}): ${holidays.join(', ') || '없음'}`)

  // 오늘이 토/일/공휴일이면 발송 건너뜀
  if (isHolidayOrWeekend(kstNow, holidays)) {
    console.log('오늘은 휴일 — 발송 건너뜀')
    return new Response(JSON.stringify({ skipped: '휴일', today }), { status: 200 })
  }

  // 발송 설정 조회
  const { data: settings } = await supabase
    .from('notification_settings').select('*').limit(1).maybeSingle()
  if (!settings) {
    return new Response(JSON.stringify({ error: 'notification_settings 없음' }), { status: 200 })
  }

  const remindDays: number = settings.remind_days_before ?? 3

  // 연체 안내 트리거 기준: +1, +7, +14일
  const OVERDUE_TRIGGER_DAYS = [1, 7, 14]

  // 활성 세입자 조회 (notification_enabled=true, is_owner=false)
  const { data: tenants } = await supabase
    .from('tenants')
    .select('*, units(unit_no)')
    .is('move_out_date', null)
    .eq('notification_enabled', true)
    .eq('is_owner', false)

  if (!tenants || tenants.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: '대상 세입자 없음' }), { status: 200 })
  }

  const results: any[] = []

  for (const tenant of tenants) {
    const paymentDay: number = tenant.payment_day
    if (!paymentDay || !tenant.phone) continue

    // 납부일이 휴일이면 다음 영업일로 보정
    const actualDueDate = getActualDueDate(kstYear, kstMonth, paymentDay, holidays)
    const actualDueDay = actualDueDate.getDate()

    let notifType: string | null = null

    // 납부 안내: 실제 납부일 N일 전인 오늘
    if (actualDueDay - todayDay === remindDays) {
      notifType = 'PAYMENT_REMIND'
    }

    // 연체 안내: 실제 납부 기한 경과 후 +1, +7, +14일 중 하나
    if (!notifType && todayDay > actualDueDay) {
      const daysPast = todayDay - actualDueDay
      if (OVERDUE_TRIGGER_DAYS.includes(daysPast)) {
        notifType = 'OVERDUE'
      }
    }

    if (!notifType) continue

    // 중복 발송 방지: 오늘 같은 타입 이미 발송됐는지 체크
    const { data: existing } = await supabase
      .from('notification_logs')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('notification_type', notifType)
      .gte('sent_at', today + 'T00:00:00+09:00')
      .lte('sent_at', today + 'T23:59:59+09:00')
      .limit(1)
      .maybeSingle()
    if (existing) continue

    // 연체 안내인 경우 연체 청구 조회
    const { data: overdueCharges } = await supabase
      .from('monthly_charges_status')
      .select('id, billing_month, outstanding, total_amount')
      .eq('tenant_id', tenant.id)
      .gt('outstanding', 0)
      .order('billing_month')

    if (notifType === 'OVERDUE' && (!overdueCharges || overdueCharges.length === 0)) continue

    // 납부 안내: 이번 달 청구 ID 조회
    let primaryChargeId: string | undefined
    if (notifType === 'PAYMENT_REMIND') {
      primaryChargeId = (await supabase
        .from('monthly_charges_status')
        .select('id')
        .eq('tenant_id', tenant.id)
        .eq('billing_month', currentBillingMonth)
        .maybeSingle()
      ).data?.id
    }

    if (notifType === 'PAYMENT_REMIND' && !primaryChargeId) continue

    // charge_details 조회
    // 납부 안내: 이번 달 1건 / 연체 안내: 전체 연체 달
    let details: any[] = []
    let overdueDetailsMap: Record<string, any[]> = {}

    if (notifType === 'PAYMENT_REMIND' && primaryChargeId) {
      const { data: d } = await supabase
        .from('charge_details')
        .select('expense_type_code, amount')
        .eq('charge_id', primaryChargeId)
      details = d || []
    } else if (notifType === 'OVERDUE' && overdueCharges && overdueCharges.length > 0) {
      const chargeIds = overdueCharges.map((c: any) => c.id)
      const { data: d } = await supabase
        .from('charge_details')
        .select('charge_id, expense_type_code, amount, expense_types(label)')
        .in('charge_id', chargeIds)
      for (const row of (d || [])) {
        if (!overdueDetailsMap[row.charge_id]) overdueDetailsMap[row.charge_id] = []
        overdueDetailsMap[row.charge_id].push(row)
      }
    }

    // 메시지 빌드
    let message = ''
    if (notifType === 'PAYMENT_REMIND') {
      const { data: charge } = await supabase
        .from('monthly_charges_status')
        .select('total_amount')
        .eq('id', primaryChargeId)
        .single()
      message = buildPaymentRemind(tenant, charge, details, settings, remindDays)
    } else {
      message = buildOverdue(tenant, overdueCharges!, overdueDetailsMap, settings)
    }

    if (!message) continue

    // PENDING 로그 먼저 저장
    const { data: log } = await supabase
      .from('notification_logs')
      .insert({ tenant_id: tenant.id, notification_type: notifType, template_content: message, status: 'PENDING' })
      .select('id')
      .single()

    // API 키 없으면 PENDING으로 종료
    if (!ALIGO_API_KEY || !ALIGO_USER_ID || !KAKAO_CHANNEL_ID) {
      results.push({ tenant: tenant.name, type: notifType, status: 'PENDING', reason: 'API 키 미설정' })
      continue
    }

    try {
      const mid = await sendAlimtalk(tenant.phone, message, notifType)
      await supabase.from('notification_logs')
        .update({ status: 'SUCCESS', aligo_message_id: mid })
        .eq('id', log.id)
      results.push({ tenant: tenant.name, type: notifType, status: 'SUCCESS' })
    } catch (e: any) {
      await supabase.from('notification_logs')
        .update({ status: 'FAILED', error_message: e.message })
        .eq('id', log.id)
      results.push({ tenant: tenant.name, type: notifType, status: 'FAILED', error: e.message })
    }
  }

  console.log('발송 결과:', JSON.stringify(results))
  return new Response(JSON.stringify({ today, results }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
})

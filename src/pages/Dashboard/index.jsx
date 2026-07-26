import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { format, differenceInDays, getDate } from 'date-fns'
import { fmt, fmtK } from '../../lib/fmt'
import ContractBadge from '../../components/ContractBadge'
import { calcNextExpiry } from '../../lib/contractUtils'

function parsePayType(memo) {
  const m = (memo || '').match(/^\[([^\]]+)\]/)
  return m ? m[1] : ''
}
const MEMO_TO_CODE = { '월세': 'RENT', '수도세': 'WATER', '정화조': 'SEPTIC' }

// 후불 정책: 입주월 자체는 청구하지 않고, 입주 다음 달부터 월세 청구 시작
// (예: 8/18 입주 → 8월엔 청구 없음, 9월부터 청구)
function isRentBillableMonth(moveInDate, billingMonth) {
  if (!moveInDate) return true
  return moveInDate.slice(0, 7) < billingMonth.slice(0, 7)
}

// 모든 섹션이 공유하는 단일 상태 판단 함수
// charge: monthly_charges_status 행 또는 null(청구 전)
// paymentDay: tenants.payment_day (1~31 또는 null)
function resolveStatus(charge, paymentDay) {
  const todayDay = new Date().getDate()
  if (!charge || Number(charge.total_amount) <= 0) return { label: '청구 전', cls: 'text-gray-500 bg-gray-100', overdue: false }
  if (charge.status === '완납') return { label: '완료', cls: 'text-green-700 bg-green-100', overdue: false }
  if (charge.status === '부분납') return { label: '부분납', cls: 'text-yellow-700 bg-yellow-100', overdue: false }
  // 미납: payment_day 기준으로 연체 여부 판단
  if (!paymentDay || paymentDay >= todayDay) {
    const label = paymentDay === todayDay ? '오늘' : '예정'
    return { label, cls: 'text-blue-600 bg-blue-100', overdue: false }
  }
  return { label: '연체', cls: 'text-red-700 bg-red-100', overdue: true }
}

function TenantRow({ tenant, charge, navigate }) {
  const { label, cls, overdue } = resolveStatus(charge, tenant.payment_day)
  return (
    <div
      onClick={() => navigate(`/tenants/${tenant.id}`)}
      className={`flex items-center justify-between py-2 px-3 rounded-lg cursor-pointer ${overdue ? 'bg-red-50' : 'hover:bg-gray-50'}`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-sm font-semibold text-gray-700 w-14 shrink-0">{tenant.units?.unit_no}</span>
        <span className="text-sm text-gray-600 truncate">{tenant.name}</span>
        {tenant.is_owner ? (
          <span className="text-xs text-gray-400 shrink-0">월세 해당없음</span>
        ) : charge && charge.total_amount > 0 ? (
          <span className="text-xs text-gray-400 shrink-0">· {fmt(charge.total_amount)}</span>
        ) : null}
      </div>
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ml-2 ${cls}`}>{label}</span>
    </div>
  )
}

function DayGroup({ day, tenants, chargeMap, isToday, navigate }) {
  return (
    <div className={`rounded-xl overflow-hidden border ${isToday ? 'border-blue-400 shadow-md' : 'border-gray-100'}`}>
      <div className={`px-3 py-2 flex items-center gap-2 ${isToday ? 'bg-blue-500 text-white' : 'bg-gray-50 text-gray-600'}`}>
        <span className={`text-sm font-bold ${isToday ? 'text-white' : 'text-gray-700'}`}>{day}일</span>
        {isToday && <span className="text-xs bg-white text-blue-600 px-2 py-0.5 rounded-full font-medium">오늘</span>}
      </div>
      <div className="bg-white px-2 py-1 space-y-0.5">
        {tenants.map(t => (
          <TenantRow key={t.id} tenant={t} charge={chargeMap[t.id]} navigate={navigate} />
        ))}
      </div>
    </div>
  )
}

function PaymentSchedule({ tenants, charges, navigate }) {
  const today = new Date()
  const todayDay = getDate(today)

  // 세입자별 이번 달 charge 객체 매핑 (null = 청구 전)
  const chargeMap = {}
  for (const t of tenants) {
    chargeMap[t.id] = charges.find(c => c.tenant_id === t.id) || null
  }

  // payment_day 기준으로 분류
  const withDay = tenants.filter(t => t.payment_day != null)
  const noDay = tenants.filter(t => t.payment_day == null)

  // 날짜별로 그룹핑
  const groupByDay = (list) => {
    const map = {}
    for (const t of list) {
      const d = t.payment_day
      if (!map[d]) map[d] = []
      map[d].push(t)
    }
    return map
  }

  const past = withDay.filter(t => t.payment_day < todayDay)
  const todayTenants = withDay.filter(t => t.payment_day === todayDay)
  const future = withDay.filter(t => t.payment_day > todayDay)

  const pastGroups = groupByDay(past)
  const futureGroups = groupByDay(future)

  // 지난 입금일: 오늘에 가까운 날짜 먼저 (내림차순)
  const pastDays = Object.keys(pastGroups).map(Number).sort((a, b) => b - a)
  // 다가오는 입금일: 오늘에 가까운 날짜 먼저 (오름차순)
  const futureDays = Object.keys(futureGroups).map(Number).sort((a, b) => a - b)

  return (
    <div className="space-y-3">
      {/* 지난 입금일 */}
      {pastDays.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase mb-2 px-1">지난 입금일</p>
          <div className="space-y-2">
            {pastDays.map(day => (
              <DayGroup key={day} day={day} tenants={pastGroups[day]} chargeMap={chargeMap} isToday={false} navigate={navigate} />
            ))}
          </div>
        </div>
      )}

      {/* 오늘 */}
      {todayTenants.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-blue-500 uppercase mb-2 px-1">오늘 ({todayDay}일)</p>
          <DayGroup day={todayDay} tenants={todayTenants} chargeMap={chargeMap} isToday={true} navigate={navigate} />
        </div>
      ) : (
        <div className="text-center py-3 text-sm text-gray-400 bg-blue-50 rounded-xl border border-blue-100">
          오늘({todayDay}일)은 입금일이 없습니다
        </div>
      )}

      {/* 다가오는 입금일 */}
      {futureDays.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase mb-2 px-1">다가오는 입금일</p>
          <div className="space-y-2">
            {futureDays.map(day => (
              <DayGroup key={day} day={day} tenants={futureGroups[day]} chargeMap={chargeMap} isToday={false} navigate={navigate} />
            ))}
          </div>
        </div>
      )}

      {/* 정보 미정 */}
      {noDay.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase mb-2 px-1">입금일 정보 미정</p>
          <div className="bg-white rounded-xl border border-gray-100 px-2 py-1 space-y-0.5">
            {noDay.map(t => (
              <TenantRow key={t.id} tenant={t} chargeStatus={chargeMap[t.id]} navigate={navigate} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  const currentMonth = format(new Date(), 'yyyy-MM-01')
  const [billingMonth, setBillingMonth] = useState(currentMonth)
  const [charges, setCharges] = useState([])
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [arrears, setArrears] = useState({})
  const [rentPaid, setRentPaid] = useState(0)
  const [waterPaid, setWaterPaid] = useState(0)
  const [septicPaid, setSepticPaid] = useState(0)
  const [autoGenError, setAutoGenError] = useState(false)
  const navigate = useNavigate()
  const today = new Date()
  const todayStr = format(today, 'yyyy-MM-dd')
  const autoGenRan = useRef(false)

  useEffect(() => { loadData() }, [billingMonth])
  useEffect(() => { loadArrears() }, [])
  useEffect(() => {
    if (autoGenRan.current) return
    autoGenRan.current = true
    autoGenCurrentMonth()
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_history' }, () => { loadData(); loadArrears() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'charge_details' }, () => { loadData() })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [billingMonth])

  async function loadData() {
    setLoading(true)
    const [{ data: chargeData }, { data: tenantData }] = await Promise.all([
      supabase
        .from('monthly_charges_status')
        .select('*, tenants(name, unit_id, contract_end, units(unit_no))')
        .eq('billing_month', billingMonth),
      supabase
        .from('tenants')
        .select('*, units(unit_no)')
        .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`)
        .order('created_at'),
    ])
    const charges = chargeData || []
    setCharges(charges)
    setTenants(tenantData || [])

    // 수금 내역을 임대료 / 공동관리비로 분리
    const chargeIds = charges.map(c => c.id).filter(Boolean)
    let rentAmt = 0, waterAmt = 0, septicAmt = 0
    if (chargeIds.length > 0) {
      const { data: pmts } = await supabase
        .from('payment_history')
        .select('amount, payment_type, memo')
        .in('charge_id', chargeIds)
        .is('reversed_at', null)
      for (const p of (pmts || [])) {
        const code = p.payment_type || MEMO_TO_CODE[parsePayType(p.memo)] || null
        if (code === 'RENT')   rentAmt   += Number(p.amount)
        else if (code === 'WATER')  waterAmt  += Number(p.amount)
        else if (code === 'SEPTIC') septicAmt += Number(p.amount)
      }
    }
    setRentPaid(rentAmt)
    setWaterPaid(waterAmt)
    setSepticPaid(septicAmt)
    setLoading(false)
  }

  async function loadArrears() {
    const todayDay = new Date().getDate()
    const { data: tenantData } = await supabase
      .from('tenants').select('id, payment_day')
      .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`)
    const activeTenantIds = (tenantData || []).map(t => t.id)
    const { data: arrearsData } = await supabase
      .from('monthly_charges_status')
      .select('tenant_id, outstanding, billing_month')
      .gt('outstanding', 0)
      .in('tenant_id', activeTenantIds.length > 0 ? activeTenantIds : ['00000000-0000-0000-0000-000000000000'])
    if (!arrearsData) return
    const payDayMap = {}
    for (const t of (tenantData || [])) payDayMap[t.id] = t.payment_day
    const map = {}
    for (const r of arrearsData) {
      const paymentDay = payDayMap[r.tenant_id] ?? null
      const bMonth = r.billing_month
      let overdue = false
      if (bMonth < currentMonth) {
        overdue = true
      } else if (bMonth === currentMonth) {
        overdue = paymentDay != null && paymentDay < todayDay
      }
      if (overdue) {
        map[r.tenant_id] = (map[r.tenant_id] || 0) + Number(r.outstanding)
      }
    }
    setArrears(map)
  }

  async function autoGenCurrentMonth() {
    try {
      const [{ data: activeTenants }, { data: existingCharges }] = await Promise.all([
        supabase.from('tenants').select('id, name, is_owner, move_in_date')
          .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`),
        supabase.from('monthly_charges').select('tenant_id').eq('billing_month', currentMonth),
      ])
      if (!activeTenants || activeTenants.length === 0) return

      const existingIds = new Set((existingCharges || []).map(c => c.tenant_id))
      const missing = activeTenants.filter(t => !existingIds.has(t.id))
      if (missing.length === 0) return

      const bDate = new Date(currentMonth + 'T00:00:00')
      const monthEnd = format(new Date(bDate.getFullYear(), bDate.getMonth() + 1, 0), 'yyyy-MM-dd')

      // 한 번에 batch insert
      const { data: created, error: insertErr } = await supabase
        .from('monthly_charges')
        .insert(missing.map(t => ({ tenant_id: t.id, billing_month: currentMonth })))
        .select('id, tenant_id')
      if (insertErr) throw insertErr

      const nonOwnerIds = missing.filter(t => !t.is_owner).map(t => t.id)
      let rentMap = {}
      if (nonOwnerIds.length > 0) {
        const { data: rentRows } = await supabase
          .from('rent_history')
          .select('tenant_id, id, rent_amount')
          .in('tenant_id', nonOwnerIds)
          .lte('effective_from', monthEnd)
          .order('effective_from', { ascending: false })
        for (const r of (rentRows || [])) {
          if (!(r.tenant_id in rentMap)) rentMap[r.tenant_id] = r
        }
      }

      const chargeDetails = (created || []).flatMap(row => {
        const t = missing.find(m => m.id === row.tenant_id)
        if (!t || t.is_owner) return []
        if (!isRentBillableMonth(t.move_in_date, currentMonth)) return []
        const rent = rentMap[row.tenant_id]
        if (!rent) return []
        return [{ charge_id: row.id, expense_type_code: 'RENT', amount: rent.rent_amount, source_rent_history_id: rent.id }]
      })
      if (chargeDetails.length > 0) {
        await supabase.from('charge_details').insert(chargeDetails)
      }

      await loadData()
    } catch (e) {
      console.error('[auto-gen] 자동 생성 실패:', e)
      setAutoGenError(true)
    }
  }

  async function generateCharges() {
    setGenerating(true)
    try {
      const { data: activeTenants } = await supabase
        .from('tenants')
        .select('id, is_owner, move_in_date')
        .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`)

      const skippedNames = []

      for (const tenant of activeTenants || []) {
        // monthly_charges: 이미 있으면 건드리지 않음
        let chargeId = null
        const { data: existing } = await supabase
          .from('monthly_charges')
          .select('id')
          .eq('tenant_id', tenant.id)
          .eq('billing_month', billingMonth)
          .maybeSingle()

        if (existing) {
          chargeId = existing.id
        } else {
          const { data: created } = await supabase
            .from('monthly_charges')
            .insert({ tenant_id: tenant.id, billing_month: billingMonth })
            .select('id')
            .single()
          chargeId = created?.id
        }

        if (!chargeId) continue

        // 후불 정책: 입주월 자체는 청구 대상이 아님 — 다음 달부터 청구
        if (!tenant.is_owner && !isRentBillableMonth(tenant.move_in_date, billingMonth)) continue

        // 해당 월 기준 유효한 월세 — billingMonth 말일까지 포함
        // billingMonth = 'yyyy-MM-01', 말일 계산: new Date(year, month+1, 0)
        const bDate = new Date(billingMonth + 'T00:00:00')
        const monthEnd = format(new Date(bDate.getFullYear(), bDate.getMonth() + 1, 0), 'yyyy-MM-dd')
        const { data: rentRow } = await supabase
          .from('rent_history')
          .select('id, rent_amount')
          .eq('tenant_id', tenant.id)
          .lte('effective_from', monthEnd)
          .order('effective_from', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!rentRow) {
          // 월세 이력 없는 세입자는 monthly_charges만 만들고 RENT detail 스킵
          const tData = tenants.find(t => t.id === tenant.id)
          skippedNames.push(tData ? `${tData.units?.unit_no} ${tData.name}` : tenant.id)
          continue
        }

        // RENT 항목 추가 (이미 있으면 무시)
        const { data: existingDetail } = await supabase
          .from('charge_details')
          .select('id')
          .eq('charge_id', chargeId)
          .eq('expense_type_code', 'RENT')
          .maybeSingle()

        if (!existingDetail && !tenant.is_owner) {
          await supabase.from('charge_details').insert({
            charge_id: chargeId,
            expense_type_code: 'RENT',
            amount: rentRow.rent_amount,
            source_rent_history_id: rentRow.id,
          })
        }
      }

      await loadData()
      if (skippedNames.length > 0) {
        alert(`청구 생성 완료\n\n⚠ 아래 세입자는 월세 이력이 없어 청구액이 ₩0으로 생성됐습니다:\n${skippedNames.join('\n')}\n\n세입자 상세 → 월세 이력 → + 변경으로 월세를 추가한 뒤 다시 '청구 생성'을 눌러주세요.`)
      } else {
        alert('이번 달 청구가 생성되었습니다.')
      }
    } catch (e) {
      console.error(e)
      alert('오류가 발생했습니다: ' + e.message)
    }
    setGenerating(false)
  }

  const totalAmount = charges.reduce((s, c) => s + Number(c.total_amount), 0)
  const totalPaid = charges.reduce((s, c) => s + Number(c.paid_amount), 0)
  const totalOutstanding = charges.reduce((s, c) => s + Number(c.outstanding), 0)
  const paidCount = charges.filter(c => c.status === '완납').length
  const partialCount = charges.filter(c => c.status === '부분납').length
  const unpaidCount = charges.filter(c => c.status === '미납').length

  const isCurrentMonth = billingMonth === currentMonth
  const noChargesYet = !loading && charges.length === 0

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    return format(d, 'yyyy-MM-01')
  })

  const overdueCount = Object.keys(arrears).length
  const overdueTotal = Object.values(arrears).reduce((s, v) => s + v, 0)

  return (
    <div className="space-y-4">
      {/* 자동 생성 실패 배너 */}
      {autoGenError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-red-800">
            이번 달 청구 자동 생성 실패 — 청구 생성 버튼을 눌러주세요
          </p>
          <button onClick={() => setAutoGenError(false)} className="text-red-400 text-lg shrink-0">✕</button>
        </div>
      )}

      {/* 연체자 배지 — 연체자 있을 때만 표시 */}
      {overdueCount > 0 && (
        <button
          onClick={() => navigate('/overdue')}
          className="w-full bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <span className="text-red-600 text-lg">⚠️</span>
            <span className="text-sm font-semibold text-red-800">
              연체 {overdueCount}명 · {fmt(overdueTotal)}
            </span>
          </div>
          <span className="text-red-400 text-lg">›</span>
        </button>
      )}

      {/* 이번 달 청구 미생성 안내 배너 */}
      {isCurrentMonth && noChargesYet && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-yellow-800">이번 달 청구가 아직 생성되지 않았습니다</p>
            <p className="text-xs text-yellow-600 mt-0.5">청구를 생성해야 입금 일정이 표시됩니다</p>
          </div>
          <button
            onClick={generateCharges}
            disabled={generating}
            className="bg-yellow-500 text-white px-4 py-2 rounded-lg text-sm font-medium shrink-0 disabled:opacity-50"
          >
            {generating ? '생성 중...' : '지금 생성'}
          </button>
        </div>
      )}

      {/* 월 선택 + 청구 생성 */}
      <div className="bg-white rounded-xl shadow-sm p-4 flex items-center gap-3">
        <select
          value={billingMonth}
          onChange={e => setBillingMonth(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          {months.map(m => (
            <option key={m} value={m}>{m.slice(0, 7)}</option>
          ))}
        </select>
        <button
          onClick={generateCharges}
          disabled={generating}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 whitespace-nowrap"
        >
          {generating ? '생성 중...' : '청구 생성'}
        </button>
      </div>

      {/* 요약 한 줄 */}
      {!loading && charges.length > 0 && (
        <div className="px-1 flex items-center gap-2 flex-wrap text-sm text-gray-500">
          <span>청구 <span className="font-semibold text-gray-800">{fmtK(totalAmount)}</span></span>
          <span className="text-gray-300">·</span>
          <span>임대료 <span className="font-semibold text-green-700">{fmtK(rentPaid)}</span></span>
          {waterPaid > 0 && (
            <>
              <span className="text-gray-300">·</span>
              <span>수도세 <span className="font-semibold text-teal-600">{fmtK(waterPaid)}</span></span>
            </>
          )}
          {septicPaid > 0 && (
            <>
              <span className="text-gray-300">·</span>
              <span>정화조 <span className="font-semibold text-teal-600">{fmtK(septicPaid)}</span></span>
            </>
          )}
          <span className="text-gray-300">·</span>
          <span>미수 <span className="font-semibold text-red-600">{fmtK(totalOutstanding)}</span></span>
          <span className="text-gray-300">·</span>
          <span className="text-xs">
            <span className="text-green-600">완납 {paidCount}</span>
            {' / '}
            <span className="text-yellow-600">부분 {partialCount}</span>
            {' / '}
            <span className="text-red-600">미납 {unpaidCount}</span>
          </span>
        </div>
      )}

      {/* 이번 달 입금 일정 (캘린더형) */}
      {isCurrentMonth && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">이번 달 입금 일정</h2>
          </div>
          {loading ? (
            <div className="p-6 text-center text-gray-400">불러오는 중...</div>
          ) : (
            <div className="p-4">
              <PaymentSchedule tenants={tenants} charges={charges} navigate={navigate} />
            </div>
          )}
        </div>
      )}

      {/* 계약 만료 임박 */}
      {tenants.filter(t => {
        if (!t.contract_end) return false
        const effective = calcNextExpiry(t)
        if (!effective) return false
        const d = differenceInDays(effective, today)
        // auto_renew=false + 만료 경과도 포함, auto_renew=true는 다음 만료 90일 이내만
        return t.auto_renew ? (d <= 90) : (d <= 90)
      }).length > 0 && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="font-semibold text-gray-800">계약 만료 임박</h2>
          </div>
          <ul className="divide-y divide-gray-50">
            {tenants
              .filter(t => {
                if (!t.contract_end) return false
                const effective = calcNextExpiry(t)
                if (!effective) return false
                return differenceInDays(effective, today) <= 90
              })
              .map(t => {
                const effective = calcNextExpiry(t)
                const displayDate = t.auto_renew
                  ? format(effective, 'yyyy-MM-dd') + ' (예상)'
                  : t.contract_end
                return (
                  <li key={t.id} className="px-4 py-3 flex items-center justify-between">
                    <span className="font-medium">{t.units?.unit_no} {t.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-500">{displayDate}</span>
                      <ContractBadge tenant={t} />
                    </div>
                  </li>
                )
              })}
          </ul>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { differenceInDays, parseISO, format } from 'date-fns'
import { fmt } from '../../lib/fmt'
import { calcNextExpiry } from '../../lib/contractUtils'

function isOverdue(billingMonth, paymentDay, currentMonth, todayDay) {
  if (billingMonth < currentMonth) return true
  if (billingMonth === currentMonth) return paymentDay != null && paymentDay < todayDay
  return false
}

export default function Tenants() {
  const [tenants, setTenants] = useState([])
  // tenant_id → [{ billing_month, outstanding, items: [{label, amount}] }]
  const [overdueMonthsMap, setOverdueMonthsMap] = useState({})
  // tenant_id → { billing_month, nonRentItems: [{label, amount}] }
  const [upcomingItemsMap, setUpcomingItemsMap] = useState({})
  // tenant_id → number (이번 달 예정 청구액 — 연체 없는 세입자 카드 헤더용)
  const [upcomingAmountMap, setUpcomingAmountMap] = useState({})
  // tenant_id → number | null (최근 월세, null = 이력 없음)
  const [rentMap, setRentMap] = useState({})
  // 미수금 있는 퇴거자 [{ tenant_id, name, unit_no, outstanding }] — 날짜 필터로 목록에서 빠진 퇴거자를 위한 진입점
  const [departedOutstanding, setDepartedOutstanding] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const today = new Date()
  const currentMonth = format(today, 'yyyy-MM-01')
  const todayDay = today.getDate()

  useEffect(() => { load() }, [])

  async function load() {
    const todayStr = format(today, 'yyyy-MM-dd')
    const [{ data: tenantData }, { data: chargeData }] = await Promise.all([
      supabase.from('tenants').select('*, units(unit_no)')
        .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`)
        .order('created_at'),
      supabase.from('monthly_charges_status')
        .select('id, tenant_id, outstanding, billing_month, total_amount')
        .gt('outstanding', 0),
    ])
    const tList = tenantData || []
    setTenants(tList)

    // 세입자별 최근 월세 조회 (effective_from 내림차순 → 첫 번째가 현재 유효)
    if (tList.length > 0) {
      const { data: rentData } = await supabase
        .from('rent_history')
        .select('tenant_id, rent_amount, effective_from')
        .in('tenant_id', tList.map(t => t.id))
        .order('effective_from', { ascending: false })
      const rMap = {}
      for (const r of (rentData || [])) {
        if (!(r.tenant_id in rMap)) rMap[r.tenant_id] = r.rent_amount
      }
      setRentMap(rMap)
    }

    const overdueRawMap = {}    // tenant_id → [{billing_month, outstanding, id}]
    const upcomingRawMap = {}   // tenant_id → {billing_month, total_amount, id}

    for (const row of (chargeData || [])) {
      const tenant = tList.find(t => t.id === row.tenant_id)
      const paymentDay = tenant?.payment_day ?? null
      if (isOverdue(row.billing_month, paymentDay, currentMonth, todayDay)) {
        if (!overdueRawMap[row.tenant_id]) overdueRawMap[row.tenant_id] = []
        overdueRawMap[row.tenant_id].push({
          billing_month: row.billing_month,
          outstanding: Number(row.outstanding),
          id: row.id,
        })
      } else if (row.billing_month === currentMonth) {
        upcomingRawMap[row.tenant_id] = {
          billing_month: row.billing_month,
          total_amount: Number(row.total_amount),
          id: row.id,
        }
      }
    }

    // 연체자의 예정 charge_id도 같이 fetch (참고 메시지용)
    const overdueTenantsWithUpcoming = Object.keys(overdueRawMap)
      .filter(tid => upcomingRawMap[tid])
      .map(tid => upcomingRawMap[tid].id)

    const fetchIds = [
      ...new Set([
        ...Object.values(overdueRawMap).flat().map(r => r.id),
        ...overdueTenantsWithUpcoming,
      ]),
    ]

    let detailsMap = {}
    if (fetchIds.length > 0) {
      const { data: details } = await supabase
        .from('charge_details')
        .select('charge_id, expense_type_code, amount, expense_types(label)')
        .in('charge_id', fetchIds)
      for (const d of (details || [])) {
        if (!detailsMap[d.charge_id]) detailsMap[d.charge_id] = []
        detailsMap[d.charge_id].push({
          code: d.expense_type_code,
          label: d.expense_types?.label || (d.expense_type_code === 'RENT' ? '월세' : d.expense_type_code),
          amount: Number(d.amount),
        })
      }
    }

    const oMap = {}
    for (const [tid, months] of Object.entries(overdueRawMap)) {
      oMap[tid] = months
        .sort((a, b) => a.billing_month.localeCompare(b.billing_month))
        .map(m => ({ billing_month: m.billing_month, outstanding: m.outstanding, items: detailsMap[m.id] || [] }))
    }

    const uItemsMap = {}
    const uAmtMap = {}
    for (const [tid, u] of Object.entries(upcomingRawMap)) {
      uAmtMap[tid] = u.total_amount
      if (overdueRawMap[tid]) {
        // 연체자: non-RENT 예정 항목 확인 (참고 메시지용)
        const items = detailsMap[u.id] || []
        const nonRentItems = items.filter(i => i.code !== 'RENT')
        if (nonRentItems.length > 0) {
          uItemsMap[tid] = { billing_month: u.billing_month, nonRentItems }
        }
      }
    }

    setOverdueMonthsMap(oMap)
    setUpcomingItemsMap(uItemsMap)
    setUpcomingAmountMap(uAmtMap)

    // 퇴거자는 위 활성 목록에서 빠지므로, 미수금(수도세 정산 부족분 등)이 남은 퇴거자를 별도로 찾아 진입점 제공
    const { data: departedRows } = await supabase
      .from('monthly_charges_status')
      .select('tenant_id, outstanding, tenants!inner(name, move_out_date, units(unit_no))')
      .gt('outstanding', 0)
      .not('tenants.move_out_date', 'is', null)
    const departedMap = {}
    for (const row of (departedRows || [])) {
      const tid = row.tenant_id
      if (!departedMap[tid]) {
        departedMap[tid] = {
          tenant_id: tid,
          name: row.tenants?.name || '?',
          unit_no: row.tenants?.units?.unit_no || '?',
          outstanding: 0,
        }
      }
      departedMap[tid].outstanding += Number(row.outstanding)
    }
    setDepartedOutstanding(Object.values(departedMap))
    setLoading(false)
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-gray-800">👥 세입자 목록</h2>

      {departedOutstanding.length > 0 && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 space-y-1.5">
          <p className="text-xs font-semibold text-purple-700">💧 미수금 있는 퇴거자 (수도세 정산 대기 등)</p>
          {departedOutstanding.map(d => (
            <button
              key={d.tenant_id}
              onClick={() => navigate(`/tenants/${d.tenant_id}`)}
              className="w-full flex items-center justify-between text-sm bg-white rounded-lg px-3 py-2 hover:bg-purple-50"
            >
              <span className="text-gray-700">{d.unit_no} {d.name}</span>
              <span className="font-semibold text-purple-700">{fmt(d.outstanding)}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-400">불러오는 중...</div>
      ) : (
        <div className="space-y-2">
          {tenants.map(t => {
            const effective = calcNextExpiry(t)
            const dl = effective ? differenceInDays(effective, today) : null
            const isPast = t.contract_end && parseISO(t.contract_end) < today
            const overdueMonths = overdueMonthsMap[t.id]
            const upcomingItems = upcomingItemsMap[t.id]
            const hasOverdue = overdueMonths && overdueMonths.length > 0
            const upcomingAmount = !hasOverdue ? upcomingAmountMap[t.id] : null

            let contractBadge = null
            if (t.contract_end) {
              if (!t.auto_renew && isPast) {
                contractBadge = <span className="text-xs font-medium text-red-700 bg-red-100 px-1.5 py-0.5 rounded">계약만료 경과</span>
              } else if (dl !== null && dl <= 90) {
                if (t.auto_renew) {
                  contractBadge = (
                    <span className="text-xs font-medium text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
                      자동갱신 D-{dl} (다음 {format(effective, 'yyyy-MM-dd')})
                    </span>
                  )
                } else {
                  const cls = dl <= 30 ? 'text-red-600 bg-red-50' : dl <= 60 ? 'text-orange-600 bg-orange-50' : 'text-yellow-600 bg-yellow-50'
                  contractBadge = <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${cls}`}>계약만료 D-{dl} ({t.contract_end})</span>
                }
              }
            }

            const phone = t.phone?.trim() || ''

            // 우선순위 배지 결정
            let priorityBadge = null
            if (t.is_owner) {
              priorityBadge = <span className="text-xs text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded">집주인 거주</span>
            } else if (t.move_out_date) {
              const dMoveOut = differenceInDays(parseISO(t.move_out_date), today)
              if (dMoveOut < 0) {
                priorityBadge = <span className="text-xs text-gray-600 bg-gray-200 px-1.5 py-0.5 rounded">퇴거 완료</span>
              } else if (dMoveOut <= 30) {
                priorityBadge = <span className="text-xs text-orange-700 bg-orange-100 px-1.5 py-0.5 rounded font-medium">퇴거 임박 D-{dMoveOut}</span>
              } else {
                priorityBadge = <span className="text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">퇴거 예정 {t.move_out_date}</span>
              }
            }

            return (
              <div
                key={t.id}
                onClick={() => navigate(`/tenants/${t.id}`)}
                className="bg-white rounded-xl shadow-sm p-4 flex items-center gap-3 cursor-pointer hover:bg-gray-50 active:bg-gray-100"
              >
                <div className={`w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                  hasOverdue ? 'bg-red-100 text-red-700' : t.is_owner ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-blue-700'
                }`}>
                  {t.units?.unit_no}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-semibold text-gray-800">{t.name}</span>
                    {priorityBadge ?? (
                      <>
                        {t.auto_renew && <span className="text-xs text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded">자동갱신</span>}
                        {hasOverdue && <span className="text-xs text-red-600 bg-red-50 px-1.5 py-0.5 rounded font-medium">연체</span>}
                      </>
                    )}
                  </div>
                  <div className="text-sm text-gray-500">
                    {t.residents}명 · 입금일 {t.payment_day}일
                    {t.phone && ` · ${t.phone}`}
                  </div>
                  <div className="text-sm text-gray-500">
                    보증금 {fmt(t.deposit)}
                    {' · 월세 '}
                    {t.id in rentMap
                      ? fmt(rentMap[t.id])
                      : <span className="text-gray-400">미정</span>}
                  </div>
                  {upcomingAmount != null && (
                    <div className="mt-1 text-xs text-blue-600">이번 달 청구 {fmt(upcomingAmount)} 예정</div>
                  )}
                  {contractBadge && <div className="mt-1">{contractBadge}</div>}
                  {t.memo && <div className="text-xs text-gray-400 mt-0.5">{t.memo}</div>}
                </div>
                {/* 연락 아이콘 */}
                <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                  <a href={phone ? `tel:${phone}` : undefined}
                    onClick={e => { if (!phone) e.preventDefault() }}
                    className={`w-9 h-9 flex items-center justify-center rounded-full text-lg ${
                      phone ? 'bg-blue-50 text-blue-600 hover:bg-blue-100' : 'bg-gray-50 text-gray-300'
                    }`}>
                    📞
                  </a>
                  <a href={phone ? `sms:${phone}` : undefined}
                    onClick={e => { if (!phone) e.preventDefault() }}
                    className={`w-9 h-9 flex items-center justify-center rounded-full text-lg ${
                      phone ? 'bg-green-50 text-green-600 hover:bg-green-100' : 'bg-gray-50 text-gray-300'
                    }`}>
                    💬
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

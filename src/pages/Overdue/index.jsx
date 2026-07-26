import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { supabase } from '../../lib/supabase'
import OverdueSection from '../../components/OverdueSection'
import NotificationModal from '../../components/NotificationModal'
import { fmt } from '../../lib/fmt'

function isOverdue(billingMonth, paymentDay, currentMonth, todayDay) {
  if (billingMonth < currentMonth) return true
  if (billingMonth === currentMonth) return paymentDay != null && paymentDay < todayDay
  return false
}

export default function OverduePage() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [notifTarget, setNotifTarget] = useState(null) // { tenant, overdueMonths }
  const today = new Date()
  const currentMonth = format(today, 'yyyy-MM-01')
  const todayDay = today.getDate()

  useEffect(() => { load() }, [])

  async function load() {
    const todayStr = format(today, 'yyyy-MM-dd')
    const [{ data: tenantData }, { data: chargeData }] = await Promise.all([
      supabase.from('tenants').select('*, units(unit_no)')
        .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`),
      supabase.from('monthly_charges_status')
        .select('id, tenant_id, outstanding, billing_month, total_amount')
        .gt('outstanding', 0),
    ])
    const tList = tenantData || []

    const overdueChargesMap = {}  // tenant_id → [{billing_month, outstanding, id}]
    const upcomingChargeMap = {}  // tenant_id → {billing_month, id}

    for (const row of (chargeData || [])) {
      const tenant = tList.find(t => t.id === row.tenant_id)
      const paymentDay = tenant?.payment_day ?? null
      if (isOverdue(row.billing_month, paymentDay, currentMonth, todayDay)) {
        if (!overdueChargesMap[row.tenant_id]) overdueChargesMap[row.tenant_id] = []
        overdueChargesMap[row.tenant_id].push({
          billing_month: row.billing_month,
          outstanding: Number(row.outstanding),
          id: row.id,
        })
      } else if (row.billing_month === currentMonth) {
        upcomingChargeMap[row.tenant_id] = { billing_month: row.billing_month, id: row.id }
      }
    }

    // 연체가 없는 세입자는 여기서 제외됨 — 아래에서 overdueChargesMap 키 기준으로만 처리
    const allChargeIds = [
      ...Object.values(overdueChargesMap).flat().map(r => r.id),
      ...Object.values(upcomingChargeMap)
        .filter(u => overdueChargesMap[Object.keys(upcomingChargeMap).find(k => upcomingChargeMap[k] === u)])
        .map(r => r.id),
    ]

    // 연체자의 예정 charge도 포함해서 fetch
    const overdueTenantsWithUpcoming = Object.keys(overdueChargesMap)
      .filter(tid => upcomingChargeMap[tid])
      .map(tid => upcomingChargeMap[tid].id)

    const fetchIds = [
      ...new Set([
        ...Object.values(overdueChargesMap).flat().map(r => r.id),
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

    const result = []
    for (const tenant of tList) {
      const overdueMths = overdueChargesMap[tenant.id]
      if (!overdueMths || overdueMths.length === 0) continue

      const overdueMonths = overdueMths
        .sort((a, b) => a.billing_month.localeCompare(b.billing_month))
        .map(m => ({
          billing_month: m.billing_month,
          outstanding: m.outstanding,
          items: detailsMap[m.id] || [],
        }))

      let upcomingItems = null
      const upcomingCharge = upcomingChargeMap[tenant.id]
      if (upcomingCharge) {
        const items = detailsMap[upcomingCharge.id] || []
        const nonRentItems = items.filter(i => i.code !== 'RENT')
        if (nonRentItems.length > 0) {
          upcomingItems = { billing_month: upcomingCharge.billing_month, nonRentItems }
        }
      }

      const totalOverdue = overdueMonths.reduce((s, m) => s + m.outstanding, 0)
      result.push({ tenant, overdueMonths, upcomingItems, totalOverdue })
    }

    result.sort((a, b) => b.totalOverdue - a.totalOverdue)
    setRows(result)
    setLoading(false)
  }

  const totalAmount = rows.reduce((s, r) => s + r.totalOverdue, 0)

  return (
    <div className="space-y-4">
      {notifTarget && (
        <NotificationModal
          tenant={notifTarget.tenant}
          overdueMonths={notifTarget.overdueMonths}
          onClose={() => setNotifTarget(null)}
        />
      )}

      <h2 className="text-xl font-bold text-gray-800">⚠️ 연체자 목록</h2>

      {loading ? (
        <div className="text-center py-8 text-gray-400">불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-gray-500 text-lg">
          연체 중인 세입자가 없습니다 🎉
        </div>
      ) : (
        <>
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-red-800">
              총 연체 {rows.length}명 · 전체 미수금 {fmt(totalAmount)}
            </p>
          </div>

          <div className="space-y-3">
            {rows.map(({ tenant, overdueMonths, upcomingItems }) => (
              <div key={tenant.id} className="bg-white rounded-xl shadow-sm p-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center text-sm font-bold text-red-700 shrink-0">
                    {tenant.units?.unit_no}
                  </div>
                  <div className="flex-1">
                    <span className="font-semibold text-gray-800">{tenant.name}</span>
                    {tenant.phone && (
                      <span className="text-sm text-gray-400 ml-2">{tenant.phone}</span>
                    )}
                  </div>
                  {!tenant.is_owner && (
                    <button
                      onClick={() => setNotifTarget({ tenant, overdueMonths })}
                      className="text-xs bg-yellow-400 text-gray-900 font-medium px-2.5 py-1.5 rounded-lg shrink-0"
                    >
                      알림톡
                    </button>
                  )}
                </div>
                <OverdueSection
                  tenant={tenant}
                  overdueMonths={overdueMonths}
                  upcomingItems={upcomingItems}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

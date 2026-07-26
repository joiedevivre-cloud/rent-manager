import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { fmt } from '../../lib/fmt'

function unitSortKey(u) {
  if (!u) return 'Z9999'
  return (u.startsWith('B') ? 'A' : 'B') + u.replace(/\D/g, '').padStart(4, '0')
}

function parsePayType(memo) {
  const m = (memo || '').match(/^\[([^\]]+)\]/)
  return m ? m[1] : ''
}

function resolveOutstandingStatus(outstanding, status, billingMonth, paymentDay) {
  const now = new Date()
  const currentMonth = format(now, 'yyyy-MM-01')
  const todayDay = now.getDate()
  if (outstanding <= 0 || status === '완납') return { label: '완납', cls: 'text-green-600 bg-green-50' }
  if (billingMonth < currentMonth) return { label: '연체', cls: 'text-red-700 bg-red-100', overdue: true }
  if (status === '부분납') {
    if (paymentDay != null && paymentDay < todayDay)
      return { label: '연체', cls: 'text-red-700 bg-red-100', overdue: true }
    return { label: '부분납', cls: 'text-yellow-700 bg-yellow-100', overdue: false }
  }
  if (paymentDay != null && paymentDay < todayDay)
    return { label: '연체', cls: 'text-red-700 bg-red-100', overdue: true }
  return { label: '예정', cls: 'text-blue-600 bg-blue-100', overdue: false }
}

const MAINTENANCE_CATEGORIES = ['수리비', '부동산 중개비', '청소비', '소방점검', '도배·장판', '기타']
const MEMO_TO_CODE = { '월세': 'RENT', '수도세': 'WATER', '정화조': 'SEPTIC', '기타': 'ETC' }

export default function Settlement() {
  const { user } = useAuth()
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = format(now, 'yyyy-MM-01')

  const months = []
  for (let m = 0; m <= now.getMonth(); m++) {
    months.push(format(new Date(currentYear, m, 1), 'yyyy-MM-01'))
  }
  months.reverse()

  const [selectedMonth, setSelectedMonth]           = useState(currentMonth)
  const [loading, setLoading]                       = useState(true)
  const [data, setData]                             = useState(null)
  const [showRentDetail, setShowRentDetail]         = useState(false)
  const [showOutstandingDetail, setShowOutstandingDetail] = useState(true) // kept for copy compat
  const [showAddForm, setShowAddForm]               = useState(false)
  const [addForm, setAddForm]                       = useState({
    record_date: format(now, 'yyyy-MM-dd'),
    category: '수리비',
    description: '',
    amount: '',
  })
  const [saving, setSaving]   = useState(false)
  const [copied, setCopied]   = useState(false)

  useEffect(() => { loadSettlement() }, [selectedMonth])

  async function loadSettlement() {
    setLoading(true)

    const [
      { data: paymentsRaw },
      { data: billsRaw },
      { data: chargesRaw },
      { data: tenantsRaw },
      { data: expTypesRaw },
      { data: maintenanceRaw },
      { data: waterCreditsRaw },
    ] = await Promise.all([
      // 실제 처리일(payment_date)이 아니라 청구 귀속월(monthly_charges.billing_month) 기준으로 집계
      // — 지연 수기입력·선납금 자동충당처럼 처리일과 귀속월이 다른 경우도 정확히 그 달 수입으로 잡힘
      supabase.from('payment_history')
        .select('id, amount, payment_date, memo, payment_type, charge_id, monthly_charges!inner(billing_month)')
        .eq('monthly_charges.billing_month', selectedMonth)
        .is('reversed_at', null),
      supabase.from('utility_bills')
        .select('id, expense_type_code, total_amount')
        .eq('billed_month', selectedMonth)
        .is('cancelled_at', null),
      supabase.from('monthly_charges_status')
        .select('tenant_id, total_amount, paid_amount, outstanding, status, tenants(name, payment_day, units(unit_no))')
        .eq('billing_month', selectedMonth),
      supabase.from('tenants')
        .select('id, name, payment_day, is_owner, units(unit_no)')
        .or(`move_out_date.is.null,move_out_date.gte.${selectedMonth}`),
      supabase.from('expense_types').select('code, label'),
      supabase.from('maintenance_records')
        .select('id, record_date, category, description, amount')
        .eq('billing_month', selectedMonth)
        .order('record_date'),
      supabase.from('tenant_water_credit_balances').select('total_balance, reserved_balance'),
    ])

    const payments    = paymentsRaw    || []
    const bills       = billsRaw       || []
    const charges     = chargesRaw     || []
    const tenants     = tenantsRaw     || []
    const expTypes    = expTypesRaw    || []
    const maintenance = maintenanceRaw || []

    const tenantMap = {}
    for (const t of tenants) tenantMap[t.id] = t

    // charge_id → tenant_id 매핑
    const chargeIds = [...new Set(payments.map(p => p.charge_id).filter(Boolean))]
    let chargeToTenant = {}
    if (chargeIds.length > 0) {
      const { data: cMap } = await supabase
        .from('monthly_charges')
        .select('id, tenant_id')
        .in('id', chargeIds)
      for (const c of (cMap || [])) chargeToTenant[c.id] = c.tenant_id
    }

    // ── 수입 집계 ─────────────────────────────────────────────
    const rentByTenant = {}
    let totalWaterIncome  = 0
    let totalSepticIncome = 0

    for (const p of payments) {
      const code     = p.payment_type || MEMO_TO_CODE[parsePayType(p.memo)] || null
      const tenantId = chargeToTenant[p.charge_id]
      const amount   = Number(p.amount)

      if (code === 'RENT') {
        if (!rentByTenant[tenantId]) {
          const t = tenantMap[tenantId]
          rentByTenant[tenantId] = { name: t?.name || '?', unitNo: t?.units?.unit_no || '?', total: 0 }
        }
        rentByTenant[tenantId].total += amount
      } else if (code === 'WATER')  { totalWaterIncome  += amount }
      else if (code === 'SEPTIC')    { totalSepticIncome += amount }
    }

    const totalRentIncome = Object.values(rentByTenant).reduce((s, r) => s + r.total, 0)

    // ── 공동관리비 고지서 집계 (상계용) ───────────────────────
    const billByType = {}
    for (const b of bills) {
      billByType[b.expense_type_code] = (billByType[b.expense_type_code] || 0) + Number(b.total_amount)
    }

    // 수납 vs 고지서 비교 (WATER, SEPTIC)
    const commonFees = [
      { code: 'WATER',  label: expTypes.find(e => e.code === 'WATER')?.label  || '수도세', collected: totalWaterIncome,  billed: billByType['WATER']  || 0 },
      { code: 'SEPTIC', label: expTypes.find(e => e.code === 'SEPTIC')?.label || '정화조', collected: totalSepticIncome, billed: billByType['SEPTIC'] || 0 },
    ].filter(f => f.collected > 0 || f.billed > 0)

    // ── 유지보수 지출 ──────────────────────────────────────────
    const totalMaintenance = maintenance.reduce((s, r) => s + Number(r.amount), 0)

    // ── 임대료 행 ─────────────────────────────────────────────
    const chargeMap = {}
    for (const c of charges) chargeMap[c.tenant_id] = c

    const rentRows = tenants
      .map(t => {
        const paid        = rentByTenant[t.id]?.total || 0
        const charge      = chargeMap[t.id]
        if (!charge && paid === 0) return null
        const outstanding = Number(charge?.outstanding || 0)
        const { label: statusLabel, cls: statusCls } = resolveOutstandingStatus(
          outstanding, charge?.status, selectedMonth, t.payment_day
        )
        return { tenantId: t.id, name: t.name, unitNo: t.units?.unit_no || '?', paidRent: paid, outstanding, statusLabel, statusCls }
      })
      .filter(Boolean)
      .sort((a, b) => unitSortKey(a.unitNo).localeCompare(unitSortKey(b.unitNo)))

    // ── 항목별 미수금 계산 ────────────────────────────────────
    // 전체 미납 청구(모든 월)를 가져와서 RENT/WATER/SEPTIC별로 분해
    const tenantIds = tenants.map(t => t.id)
    let allOutstandingStatus = []
    if (tenantIds.length > 0) {
      const { data: aos } = await supabase
        .from('monthly_charges_status')
        .select('id, tenant_id, billing_month, outstanding, status')
        .in('tenant_id', tenantIds)
        .gt('outstanding', 0)
      allOutstandingStatus = aos || []
    }

    const allOutstandingIds = allOutstandingStatus.map(c => c.id)
    let allTypeDetails = []
    let allTypePayments = []
    if (allOutstandingIds.length > 0) {
      const [{ data: td }, { data: tp }] = await Promise.all([
        supabase.from('charge_details')
          .select('charge_id, expense_type_code, amount')
          .in('charge_id', allOutstandingIds),
        supabase.from('payment_history')
          .select('charge_id, payment_type, memo, amount')
          .in('charge_id', allOutstandingIds)
          .is('reversed_at', null),
      ])
      allTypeDetails = td || []
      allTypePayments = tp || []
    }

    // charge_id → { typeCode: paidAmount }
    const paidByTypeByCharge = {}
    for (const p of allTypePayments) {
      if (!paidByTypeByCharge[p.charge_id]) paidByTypeByCharge[p.charge_id] = {}
      const code = p.payment_type || MEMO_TO_CODE[parsePayType(p.memo)] || 'OTHER'
      paidByTypeByCharge[p.charge_id][code] = (paidByTypeByCharge[p.charge_id][code] || 0) + Number(p.amount)
    }

    // charge_id → [{ expense_type_code, amount }]
    const detailsByCharge = {}
    for (const d of allTypeDetails) {
      if (!detailsByCharge[d.charge_id]) detailsByCharge[d.charge_id] = []
      detailsByCharge[d.charge_id].push(d)
    }

    // tenant_id → typeCode → { amount, overdueCount, hasCurrentPartial }
    const typeOutstandingByTenant = {}
    for (const charge of allOutstandingStatus) {
      const tid = charge.tenant_id
      const paymentDay = tenantMap[tid]?.payment_day ?? null
      const chargeIsOverdue =
        charge.billing_month < currentMonth ||
        (charge.billing_month === currentMonth && paymentDay != null && paymentDay < now.getDate())

      for (const detail of (detailsByCharge[charge.id] || [])) {
        const code = detail.expense_type_code
        const charged = Number(detail.amount)
        const paid = paidByTypeByCharge[charge.id]?.[code] || 0
        const typeOut = Math.max(0, charged - paid)
        if (typeOut <= 0) continue

        if (!typeOutstandingByTenant[tid]) typeOutstandingByTenant[tid] = {}
        if (!typeOutstandingByTenant[tid][code])
          typeOutstandingByTenant[tid][code] = { amount: 0, overdueCount: 0, hasCurrentPartial: false }

        const entry = typeOutstandingByTenant[tid][code]
        entry.amount += typeOut
        if (chargeIsOverdue) {
          entry.overdueCount++
        } else if (paid > 0) {
          entry.hasCurrentPartial = true
        }
      }
    }

    // 섹션 구성: RENT → WATER → SEPTIC (SEPTIC은 이번 달 고지서 있을 때만)
    const hasSepticBill = bills.some(b => b.expense_type_code === 'SEPTIC')
    const SECTION_TYPES = [
      { code: 'RENT',   label: '임대료' },
      { code: 'WATER',  label: '수도세' },
      { code: 'SEPTIC', label: '정화조' },
    ]

    const outstandingSections = []
    for (const { code, label } of SECTION_TYPES) {
      if (code === 'SEPTIC' && !hasSepticBill) continue

      const rows = []
      for (const t of tenants) {
        const entry = typeOutstandingByTenant[t.id]?.[code]
        if (!entry || entry.amount <= 0) continue
        if (code === 'RENT' && t.is_owner) continue

        let statusLabel, statusCls
        if (entry.overdueCount > 1) {
          statusLabel = `연체 (${entry.overdueCount}개월)`
          statusCls = 'text-red-700 bg-red-100'
        } else if (entry.overdueCount === 1) {
          statusLabel = '연체'
          statusCls = 'text-red-700 bg-red-100'
        } else if (entry.hasCurrentPartial) {
          statusLabel = '부분납'
          statusCls = 'text-yellow-700 bg-yellow-100'
        } else {
          statusLabel = '예정'
          statusCls = 'text-blue-600 bg-blue-100'
        }

        rows.push({
          tenantId: t.id,
          name: t.name,
          unitNo: t.units?.unit_no || '?',
          amount: entry.amount,
          statusLabel,
          statusCls,
        })
      }

      rows.sort((a, b) => unitSortKey(a.unitNo).localeCompare(unitSortKey(b.unitNo)))
      if (rows.length > 0) {
        outstandingSections.push({ code, label, rows, subtotal: rows.reduce((s, r) => s + r.amount, 0) })
      }
    }

    const totalOutstanding = outstandingSections.reduce((s, sec) => s + sec.subtotal, 0)

    // 수도세 선납 예수금 총액 — 실제 수도세 수납(위 commonFees)과는 별개의 부채성 예수금.
    // 충당된 시점의 금액만 이미 payment_history를 통해 수도세 수납으로 집계되므로 중복 계상 아님.
    const waterCredits = waterCreditsRaw || []
    const totalWaterCreditBalance = waterCredits.reduce((s, r) => s + Number(r.total_balance || 0), 0)
    const totalWaterCreditReserved = waterCredits.reduce((s, r) => s + Number(r.reserved_balance || 0), 0)

    setData({
      rentRows,
      totalRentIncome,
      commonFees,
      maintenance,
      totalMaintenance,
      actualIncome: totalRentIncome - totalMaintenance,
      outstandingSections,
      totalOutstanding,
      totalWaterCreditBalance,
      totalWaterCreditReserved,
    })
    setLoading(false)
  }

  async function saveMaintenance() {
    if (!addForm.description.trim() || !addForm.amount) { alert('내용과 금액을 입력해주세요.'); return }
    setSaving(true)
    const { error } = await supabase.from('maintenance_records').insert({
      record_date:   addForm.record_date,
      category:      addForm.category,
      description:   addForm.description.trim(),
      amount:        Number(addForm.amount),
      billing_month: selectedMonth,
      created_by:    user?.id,
    })
    if (error) { alert('저장 오류: ' + error.message); setSaving(false); return }
    setAddForm({ record_date: format(new Date(), 'yyyy-MM-dd'), category: '수리비', description: '', amount: '' })
    setShowAddForm(false)
    setSaving(false)
    await loadSettlement()
  }

  async function deleteMaintenance(id) {
    if (!confirm('이 지출 항목을 삭제하시겠습니까?')) return
    await supabase.from('maintenance_records').delete().eq('id', id)
    await loadSettlement()
  }

  // ── 복사 텍스트 ──────────────────────────────────────────────
  function buildCopyText() {
    if (!data) return ''
    const { rentRows, totalRentIncome, commonFees, maintenance, totalMaintenance, actualIncome, outstandingSections, totalOutstanding } = data
    const ym = `${selectedMonth.slice(0, 4)}년 ${Number(selectedMonth.slice(5, 7))}월`
    const lines = [`[${ym} 정산]`, '']

    lines.push('── 수입 ──────────────────────')
    lines.push(`임대료 수금        ${fmt(totalRentIncome)}`)
    for (const r of rentRows) {
      const tag = r.outstanding === 0 ? '✓완납' : r.statusLabel
      lines.push(`  ${r.unitNo.padEnd(5)} ${r.name.padEnd(6)} ${String(fmt(r.paidRent)).padStart(14)}  ${tag}`)
    }
    if (commonFees.length > 0) {
      lines.push('')
      for (const f of commonFees) {
        const diff = f.collected - f.billed
        const diffStr = diff === 0 ? '완납' : diff < 0 ? `미수 ${fmt(-diff)}` : `초과 ${fmt(diff)}`
        lines.push(`${f.label}  수납 ${fmt(f.collected)} / 고지서 ${fmt(f.billed)}  (${diffStr})`)
      }
    }

    if (maintenance.length > 0) {
      lines.push('', '── 지출 (유지보수·기타) ──────')
      for (const r of maintenance) {
        lines.push(`${r.record_date}  ${r.category}  ${r.description}  ${fmt(r.amount)}`)
      }
      lines.push(`지출 합계          ${fmt(totalMaintenance)}`)
    }

    lines.push('', '── 정산 ──────────────────────')
    lines.push(`실 수령액           ${fmt(actualIncome)}`)
    lines.push('(임대료 수금 - 유지보수 지출)')

    if (totalOutstanding > 0) {
      lines.push('', `미수금 합계         ${fmt(totalOutstanding)}`)
      for (const section of outstandingSections) {
        lines.push('', `  ── ${section.label} 미수 (소계 ${fmt(section.subtotal)})`)
        for (const r of section.rows) {
          lines.push(`  ${r.unitNo.padEnd(5)} ${r.name.padEnd(6)} ${String(fmt(r.amount)).padStart(14)}  ${r.statusLabel}`)
        }
      }
    }
    return lines.join('\n')
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(buildCopyText())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const ymLabel = `${selectedMonth.slice(0, 4)}년 ${Number(selectedMonth.slice(5, 7))}월 정산`

  return (
    <div className="space-y-3">
      {/* 월 선택 */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-gray-700 shrink-0">{ymLabel}</span>
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
        >
          {months.map(m => (
            <option key={m} value={m}>{m.slice(0, 4)}년 {Number(m.slice(5, 7))}월</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">불러오는 중...</div>
      ) : !data ? null : (
        <>
          {/* ── 수입 ── */}
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-2">
            <p className="text-xs font-bold text-gray-400 tracking-wider mb-2">── 수입</p>

            {/* 임대료 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-gray-700">임대료 수금</span>
                <button onClick={() => setShowRentDetail(v => !v)} className="text-xs text-blue-500">
                  {showRentDetail ? '▲ 접기' : '▼ 펼치기'}
                </button>
              </div>
              <span className="font-semibold text-gray-800">{fmt(data.totalRentIncome)}</span>
            </div>

            {showRentDetail && (
              <div className="ml-2 pt-1 space-y-1 border-l-2 border-gray-100 pl-3">
                {data.rentRows.map(r => (
                  <div key={r.tenantId} className={`flex items-center justify-between text-sm ${r.outstanding > 0 ? 'text-gray-400' : ''}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-11 shrink-0 text-xs font-medium text-gray-500">{r.unitNo}</span>
                      <span className="truncate">{r.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className={r.outstanding === 0 ? 'font-medium text-gray-700' : 'text-gray-400'}>{fmt(r.paidRent)}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${r.statusCls}`}>
                        {r.outstanding === 0 ? '✓완납' : r.statusLabel}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 공동관리비 수납 vs 고지서 */}
            {data.commonFees.length > 0 && (
              <>
                <div className="pt-1 border-t border-gray-100 mt-1">
                  <span className="text-xs font-medium text-gray-500">공동관리비 (수납 / 고지서)</span>
                </div>
                {data.commonFees.map(f => {
                  const diff = f.collected - f.billed
                  const isShort = diff < 0
                  const isOver  = diff > 0
                  return (
                    <div key={f.code} className="flex items-start justify-between ml-2 text-sm">
                      <span className="text-gray-600 shrink-0 w-14">{f.label}</span>
                      <div className="text-right">
                        <div className="text-gray-700">
                          수납 {fmt(f.collected)} / 고지서 {fmt(f.billed)}
                        </div>
                        {diff !== 0 && (
                          <div className={`text-xs mt-0.5 ${isShort ? 'text-orange-600' : 'text-green-600'}`}>
                            {isShort ? `미수 ${fmt(-diff)}` : `초과 ${fmt(diff)}`}
                          </div>
                        )}
                        {diff === 0 && f.billed > 0 && (
                          <div className="text-xs text-green-600 mt-0.5">상계 완료</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {/* 수도세 선납 예수금 — 부채성 잔액, 수입 아님(중복 집계 방지 명시) */}
            {data.totalWaterCreditBalance > 0 && (
              <div className="pt-1 border-t border-gray-100 mt-1 flex items-center justify-between text-xs">
                <span className="text-gray-500">세입자 수도세 선납 예수금 (부채성 · 수입 아님)</span>
                <span className="font-medium text-gray-600">
                  {fmt(data.totalWaterCreditBalance)}
                  {data.totalWaterCreditReserved > 0 && ` (퇴거 정산대기 ${fmt(data.totalWaterCreditReserved)} 포함)`}
                </span>
              </div>
            )}
          </div>

          {/* ── 지출 (유지보수·기타) ── */}
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-bold text-gray-400 tracking-wider">── 지출 (유지보수·기타)</p>
              <button
                onClick={() => setShowAddForm(v => !v)}
                className="text-xs bg-gray-800 text-white px-3 py-1.5 rounded-lg"
              >
                {showAddForm ? '닫기' : '+ 지출 추가'}
              </button>
            </div>

            {/* 지출 추가 폼 */}
            {showAddForm && (
              <div className="space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">날짜</label>
                    <input
                      type="date"
                      value={addForm.record_date}
                      onChange={e => setAddForm(f => ({ ...f, record_date: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">분류</label>
                    <select
                      value={addForm.category}
                      onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      {MAINTENANCE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <input
                  type="text"
                  value={addForm.description}
                  onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="내용 (예: 화장실 누수 수리)"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  value={addForm.amount}
                  onChange={e => setAddForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="금액"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  inputMode="numeric"
                />
                <div className="flex gap-2">
                  <button onClick={() => setShowAddForm(false)} className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm">취소</button>
                  <button onClick={saveMaintenance} disabled={saving} className="flex-1 bg-gray-800 text-white py-2 rounded-lg text-sm disabled:opacity-50">
                    {saving ? '저장 중...' : '저장'}
                  </button>
                </div>
              </div>
            )}

            {/* 지출 목록 */}
            {data.maintenance.length === 0 ? (
              <p className="text-sm text-gray-400 py-2 text-center">이번 달 지출 없음</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  {data.maintenance.map(r => (
                    <div key={r.id} className="flex items-center justify-between text-sm">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs text-gray-400 mr-2">{r.record_date}</span>
                        <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded mr-1.5">{r.category}</span>
                        <span className="text-gray-700">{r.description}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="font-semibold text-gray-800">{fmt(r.amount)}</span>
                        <button onClick={() => deleteMaintenance(r.id)} className="text-red-400 text-xs hover:text-red-600">✕</button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <span className="text-sm font-bold text-gray-800">지출 합계</span>
                  <span className="font-bold text-gray-800">{fmt(data.totalMaintenance)}</span>
                </div>
              </>
            )}
          </div>

          {/* ── 정산 ── */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <p className="text-xs font-bold text-blue-400 tracking-wider mb-3">── 정산</p>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-bold text-blue-800">실 수령액</p>
                <p className="text-xs text-blue-500 mt-0.5">임대료 수금 − 유지보수 지출</p>
              </div>
              <span className={`text-2xl font-bold ${data.actualIncome >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                {fmt(data.actualIncome)}
              </span>
            </div>
          </div>

          {/* ── 미수금 (항목별 섹션) ── */}
          {data.totalOutstanding > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
              {/* 합계 헤더 */}
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-red-400 tracking-wider">── 미수금</p>
                <span className="font-bold text-red-800">{fmt(data.totalOutstanding)}</span>
              </div>

              {/* 항목별 섹션 */}
              {data.outstandingSections.map(section => (
                <div key={section.code} className="space-y-1.5">
                  {/* 섹션 헤더 */}
                  <div className="flex items-center justify-between text-xs font-semibold text-red-600 border-b border-red-200 pb-1">
                    <span>── {section.label} 미수</span>
                    <span>소계 {fmt(section.subtotal)}</span>
                  </div>
                  {/* 호실 행 */}
                  {section.rows.map(r => (
                    <div key={r.tenantId} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-11 shrink-0 text-xs font-medium text-red-700">{r.unitNo}</span>
                        <span className="text-red-800 truncate">{r.name}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="font-semibold text-red-800">{fmt(r.amount)}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${r.statusCls}`}>{r.statusLabel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* 복사 버튼 */}
          <button
            onClick={handleCopy}
            className={`w-full py-3 rounded-xl text-sm font-medium transition-colors ${
              copied ? 'bg-green-600 text-white' : 'bg-gray-800 text-white hover:bg-gray-700'
            }`}
          >
            {copied ? '✓ 복사됨' : '이 정산 내역 복사'}
          </button>
        </>
      )}
    </div>
  )
}

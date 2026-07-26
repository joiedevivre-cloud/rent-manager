import { useEffect, useState, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { format } from 'date-fns'
import Settlement from './Settlement'
import NotificationSettings from './NotificationSettings'
import NotificationHistory from './NotificationHistory'
import { fmt, fmtNum } from '../../lib/fmt'

// B101, B102 → 앞, 이후 101~401옥탑 순
function unitSortKey(unitNo) {
  if (!unitNo) return 'Z9999'
  const digits = unitNo.replace(/[^0-9]/g, '').padStart(4, '0')
  return unitNo.startsWith('B') ? 'A' + digits : 'B' + digits
}

// 직전 사용량 대비 변화 계산
function calcUsageDiff(current, prev, unit) {
  if (current == null || prev == null || Number(prev) === 0) return null
  const cur = Number(current)
  const pv = Number(prev)
  const diff = cur - pv
  const pct = Math.round((diff / pv) * 100)
  const u = unit || '㎥'
  const sign = diff >= 0 ? '+' : ''
  const label = `직전(${fmtNum(pv)}${u}) 대비: ${sign}${diff % 1 === 0 ? fmtNum(diff) : diff.toFixed(2)}${u} (${sign}${pct}%)`
  if (Math.abs(pct) >= 20) {
    if (diff < 0) return { label, warning: '⚠ 사용량 급감 — 퇴거 / 계량기 확인 필요', cls: 'text-red-700 bg-red-50 border border-red-200' }
    return { label, warning: '⚠ 사용량 급증 — 누수 확인 필요', cls: 'text-orange-700 bg-orange-50 border border-orange-200' }
  }
  return { label, cls: diff < 0 ? 'text-blue-600 bg-blue-50' : 'text-gray-600 bg-gray-50' }
}

export default function Bills() {
  const { user } = useAuth()
  const [activeTab, setActiveTab] = useState('bills')
  const [bills, setBills] = useState([])
  const [expenseTypes, setExpenseTypes] = useState([])
  const [tenants, setTenants] = useState([])
  const [billDiscounts, setBillDiscounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [showTypeForm, setShowTypeForm] = useState(false)
  const [form, setForm] = useState({
    expense_type_code: '',
    total_amount: '',
    usage_amount: '',
    usage_unit: '㎥',
    period_start: '',
    period_end: '',
    billed_month: format(new Date(), 'yyyy-MM-01'),
    discounts: [],
  })
  const [typeForm, setTypeForm] = useState({ code: '', label: '' })
  const [distributing, setDistributing] = useState(null)
  const [selectedBillId, setSelectedBillId] = useState(null)
  const [billRows, setBillRows] = useState([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [receiptFile, setReceiptFile] = useState(null)
  const receiptFileRef = useRef()

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLoading(true)
    const todayStr = format(new Date(), 'yyyy-MM-dd')
    const [{ data: billData }, { data: typeData }, { data: tenantData }] = await Promise.all([
      supabase
        .from('utility_bills')
        .select('*, profiles!utility_bills_created_by_fkey(name,email), cancelled_profiles:profiles!utility_bills_cancelled_by_fkey(name,email)')
        .order('billed_month', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('expense_types').select('*').neq('code', 'RENT').order('created_at'),
      supabase.from('tenants').select('id, name, units(unit_no)')
        .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`)
        .order('created_at'),
    ])
    const types = typeData || []
    const bills = billData || []
    setBills(bills)
    setExpenseTypes(types)
    setTenants(tenantData || [])
    if (types.length > 0) setForm(f => ({ ...f, expense_type_code: f.expense_type_code || types[0].code }))

    const billIds = bills.map(b => b.id)
    if (billIds.length > 0) {
      const { data: discData } = await supabase
        .from('utility_bill_discounts')
        .select('*, tenants(name, units(unit_no))')
        .in('bill_id', billIds)
      const discMap = {}
      for (const d of (discData || [])) {
        if (!discMap[d.bill_id]) discMap[d.bill_id] = []
        discMap[d.bill_id].push(d)
      }
      setBillDiscounts(discMap)
    } else {
      setBillDiscounts({})
    }
    setLoading(false)
  }

  function addDiscountRow() {
    setForm(f => ({ ...f, discounts: [...f.discounts, { tenant_id: '', amount: '', reason: '' }] }))
  }
  function updateDiscountRow(idx, patch) {
    setForm(f => ({ ...f, discounts: f.discounts.map((d, i) => i === idx ? { ...d, ...patch } : d) }))
  }
  function removeDiscountRow(idx) {
    setForm(f => ({ ...f, discounts: f.discounts.filter((_, i) => i !== idx) }))
  }

  // 같은 expense_type의 직전 고지서 찾기
  function prevBillFor(bill) {
    return bills
      .filter(b => b.expense_type_code === bill.expense_type_code && b.id !== bill.id && !b.cancelled_at && b.usage_amount != null)
      .filter(b => b.billed_month < bill.billed_month || (b.billed_month === bill.billed_month && b.created_at < bill.created_at))
      .sort((a, b) => b.billed_month.localeCompare(a.billed_month) || b.created_at.localeCompare(a.created_at))
      [0] || null
  }

  // 폼에서 현재 선택된 항목의 직전 고지서
  function prevBillInForm() {
    return bills
      .filter(b => b.expense_type_code === form.expense_type_code && !b.cancelled_at && b.usage_amount != null)
      .filter(b => b.billed_month < form.billed_month)
      .sort((a, b) => b.billed_month.localeCompare(a.billed_month))
      [0] || null
  }

  async function loadBillDetails(billId) {
    setDetailLoading(true)
    setBillRows([])
    const { data } = await supabase
      .from('charge_details')
      .select('amount, monthly_charges(tenant_id, tenants(name, residents, units(unit_no)))')
      .eq('source_bill_id', billId)
    const rows = (data || []).map(d => ({
      tenantId: d.monthly_charges?.tenant_id || null,
      unit_no: d.monthly_charges?.tenants?.units?.unit_no || '?',
      name: d.monthly_charges?.tenants?.name || '?',
      residents: d.monthly_charges?.tenants?.residents || 0,
      amount: Number(d.amount),
    }))
    rows.sort((a, b) => (unitSortKey(a.unit_no) < unitSortKey(b.unit_no) ? -1 : 1))
    setBillRows(rows)
    setDetailLoading(false)
  }

  function toggleDetail(bill) {
    if (bill.cancelled_at) return
    if (selectedBillId === bill.id) {
      setSelectedBillId(null)
      setBillRows([])
    } else {
      setSelectedBillId(bill.id)
      loadBillDetails(bill.id)
    }
  }

  function copyBillText(bill) {
    const typeLabel = expenseTypes.find(t => t.code === bill.expense_type_code)?.label || bill.expense_type_code
    const bDate = new Date(bill.billed_month + 'T00:00:00')
    const year = bDate.getFullYear()
    const month = bDate.getMonth() + 1
    const totalR = billRows.reduce((s, r) => s + r.residents, 0)
    const totalA = billRows.reduce((s, r) => s + r.amount, 0)
    const perP = totalR > 0 ? Math.round(totalA / totalR) : 0

    const lines = [`[${year}년 ${month}월 ${typeLabel}]`]
    if (bill.usage_amount != null) {
      if (bill.period_start && bill.period_end) lines.push(`사용기간: ${bill.period_start} ~ ${bill.period_end}`)
      lines.push(`사용량: ${bill.usage_amount}${bill.usage_unit || '㎥'}`)
    }
    lines.push(`사용요금: ${fmtNum(bill.total_amount)}원`)
    lines.push(`총인원: ${totalR}명`)
    lines.push('')
    for (const r of billRows) lines.push(`${r.unit_no} : ${r.residents}인 : ${fmtNum(r.amount)}원`)
    lines.push('', `분담금 합계: ${fmtNum(totalA)}원`, `1인당: ${fmtNum(perP)}원`)

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopyFeedback(bill.id)
      setTimeout(() => setCopyFeedback(null), 2000)
    })
  }

  async function generateImage(bill) {
    if (generating || billRows.length === 0) return
    setGenerating(true)
    try {
      const typeLabel = expenseTypes.find(t => t.code === bill.expense_type_code)?.label || bill.expense_type_code
      const bDate = new Date(bill.billed_month + 'T00:00:00')
      const year = bDate.getFullYear()
      const month = bDate.getMonth() + 1
      const totalR = billRows.reduce((s, r) => s + r.residents, 0)
      const totalA = billRows.reduce((s, r) => s + r.amount, 0)
      const perP = totalR > 0 ? Math.round(totalA / totalR) : 0

      // React 렌더 사이클 없이 DOM 직접 생성 — 타이밍 문제 없음
      const wrap = document.createElement('div')
      wrap.style.cssText = [
        'position:fixed', 'left:-9999px', 'top:0', 'z-index:-1',
        'background:#ffffff', 'padding:44px 48px', 'width:700px',
        'font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif',
        'box-sizing:border-box',
      ].join(';')

      const h = (tag, style, text) => {
        const el = document.createElement(tag)
        el.style.cssText = style
        if (text != null) el.textContent = text
        return el
      }
      const flex = (items) => {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center'
        items.forEach(([text, style]) => {
          const span = document.createElement('span')
          span.style.cssText = style
          span.textContent = text
          row.appendChild(span)
        })
        return row
      }

      wrap.appendChild(h('div', 'font-size:13px;color:#9ca3af;margin-bottom:10px;letter-spacing:0.03em', '공동관리비 분담 내역'))
      wrap.appendChild(h('h1', 'font-size:34px;font-weight:800;color:#111827;margin:0 0 20px;letter-spacing:-0.5px;line-height:1.2', `${year}년 ${month}월 ${typeLabel}`))

      // 상단 정보 블록 — 라벨/값 줄별 나열
      const infoBlock = document.createElement('div')
      infoBlock.style.cssText = 'margin-bottom:24px;padding-bottom:20px;border-bottom:2px solid #e5e7eb'

      const infoRow = (label, value) => {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:baseline;margin-bottom:10px'
        const lEl = h('span', 'font-size:15px;color:#6b7280;width:90px;flex-shrink:0', label + ':')
        const vEl = h('span', 'font-size:20px;font-weight:700;color:#111827', value)
        row.appendChild(lEl); row.appendChild(vEl)
        return row
      }

      if (bill.usage_amount != null) {
        if (bill.period_start && bill.period_end)
          infoBlock.appendChild(infoRow('사용기간', `${bill.period_start} ~ ${bill.period_end}`))
        infoBlock.appendChild(infoRow('사용량', `${bill.usage_amount}${bill.usage_unit || '㎥'}`))
      }
      infoBlock.appendChild(infoRow('사용요금', `${fmtNum(bill.total_amount)}원`))
      infoBlock.appendChild(infoRow('총인원', `${totalR}명`))
      wrap.appendChild(infoBlock)

      const COL = ['0 0 90px', '1', '0 0 60px', '0 0 150px']
      const headerRow = flex([
        ['호실', `flex:${COL[0]};font-size:14px;color:#6b7280;font-weight:600`],
        ['이름', `flex:${COL[1]};font-size:14px;color:#6b7280;font-weight:600`],
        ['인원', `flex:${COL[2]};font-size:14px;color:#6b7280;font-weight:600;text-align:center`],
        ['분담금', `flex:${COL[3]};font-size:14px;color:#6b7280;font-weight:600;text-align:right`],
      ])
      headerRow.style.cssText += ';padding:0 0 10px;border-bottom:1px solid #d1d5db;margin-bottom:2px'
      wrap.appendChild(headerRow)

      for (const r of billRows) {
        const row = flex([
          [r.unit_no,           `flex:${COL[0]};font-size:22px;font-weight:700;color:#111827`],
          [r.name,              `flex:${COL[1]};font-size:20px;color:#1f2937`],
          [`${r.residents}인`,  `flex:${COL[2]};font-size:18px;color:#4b5563;text-align:center`],
          [`${fmtNum(r.amount)}원`, `flex:${COL[3]};font-size:22px;font-weight:700;color:#111827;text-align:right`],
        ])
        row.style.cssText += ';padding:13px 0;border-bottom:1px solid #f3f4f6'
        wrap.appendChild(row)
      }

      const total = document.createElement('div')
      total.style.cssText = 'margin-top:20px;padding-top:18px;border-top:2px solid #374151'
      const sumRow = flex([
        ['분담금 합계', 'flex:1;font-size:19px;font-weight:700;color:#374151'],
        [`${fmtNum(totalA)}원`, 'font-size:22px;font-weight:800;color:#111827'],
      ])
      sumRow.style.cssText += ';margin-bottom:10px'
      const perRow = flex([
        ['1인당 단가', 'flex:1;font-size:15px;color:#6b7280'],
        [`${fmtNum(perP)}원`, 'font-size:15px;color:#6b7280'],
      ])
      total.appendChild(sumRow)
      total.appendChild(perRow)
      wrap.appendChild(total)

      wrap.appendChild(h('div', 'margin-top:28px;text-align:right;font-size:12px;color:#9ca3af', `${year}년 ${month}월 생성`))

      document.body.appendChild(wrap)
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(wrap, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false })
      document.body.removeChild(wrap)

      const mStr = String(month).padStart(2, '0')
      const a = document.createElement('a')
      a.download = `${year}-${mStr}_${typeLabel}_분담내역.png`
      a.href = canvas.toDataURL('image/png')
      a.click()
    } catch (e) {
      alert('이미지 생성 오류: ' + e.message)
    }
    setGenerating(false)
  }

  async function addBill() {
    if (!form.total_amount || Number(form.total_amount) <= 0) { alert('금액을 입력해주세요.'); return }

    if (form.expense_type_code === 'WATER' && (!form.period_start || !form.period_end)) {
      alert('수도세는 거주일수 기준으로 배분되므로 사용기간(시작일/종료일)을 반드시 입력해주세요.')
      return
    }

    const validDiscounts = form.discounts.filter(d => d.tenant_id && Number(d.amount) > 0)
    if (validDiscounts.some(d => form.discounts.filter(d2 => d2.tenant_id === d.tenant_id).length > 1)) {
      alert('같은 세대에 감면이 중복 입력되어 있습니다.'); return
    }

    let receiptPath = null
    if (receiptFile) {
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('utility-bills')
        .upload(`${Date.now()}_${receiptFile.name}`, receiptFile)
      if (uploadError) { alert('영수증 업로드 오류: ' + uploadError.message); return }
      receiptPath = uploadData.path
    }

    const { data: insertedBill, error } = await supabase.from('utility_bills').insert({
      expense_type_code: form.expense_type_code,
      total_amount: Number(form.total_amount),
      usage_amount: form.usage_amount ? Number(form.usage_amount) : null,
      usage_unit: form.usage_unit || '㎥',
      period_start: form.period_start || null,
      period_end: form.period_end || null,
      billed_month: form.billed_month,
      created_by: user.id,
      receipt_path: receiptPath,
    }).select('id').single()
    if (error) {
      if (error.code === '23505') alert('같은 기간에 이미 동일한 고지서가 입력되어 있습니다.')
      else alert('오류: ' + error.message)
      return
    }

    if (validDiscounts.length > 0) {
      const { error: discError } = await supabase.from('utility_bill_discounts').insert(
        validDiscounts.map(d => ({
          bill_id: insertedBill.id,
          tenant_id: d.tenant_id,
          amount: Number(d.amount),
          reason: d.reason?.trim() || null,
          created_by: user.id,
        }))
      )
      if (discError) alert('감면 정보 저장 오류: ' + discError.message)
    }

    setShowForm(false)
    setReceiptFile(null)
    setForm(f => ({ ...f, total_amount: '', usage_amount: '', period_start: '', period_end: '', discounts: [] }))
    await loadData()
  }

  async function cancelBill(bill) {
    if (!confirm(`${fmt(bill.total_amount)} 고지서를 취소하시겠습니까?`)) return
    const { data: rpcResult, error } = await supabase
      .rpc('cancel_utility_bill_distribution', { p_bill_id: bill.id })
    if (error) { alert('오류: ' + error.message); return }
    if (!rpcResult?.success) {
      const errMap = {
        BILL_NOT_FOUND: '고지서를 찾을 수 없습니다.',
        ALREADY_CANCELLED: '이미 취소된 고지서입니다.',
        RESERVATION_ALREADY_SETTLED_BY_LATER_BILL:
          '이 고지서로 정산된 퇴거자 선납 예약이 이후의 다른 고지서로 이미 최종 정산됐습니다.\n' +
          '더 최근에 등록된 고지서부터 역순으로 취소해주세요.',
      }
      alert('⚠ ' + (errMap[rpcResult?.error] || rpcResult?.error || '알 수 없는 오류'))
      return
    }
    if (selectedBillId === bill.id) { setSelectedBillId(null); setBillRows([]) }
    await loadData()
  }

  async function distributeBill(bill) {
    if (bill.distributed_at) return
    setDistributing(bill.id)
    try {
      if (bill.expense_type_code === 'WATER') {
        // 수도세: 거주일수 가중 통합 배분 (현재+퇴거+신규입주 세대 전체) — RPC가 전부 처리
        if (!bill.period_start || !bill.period_end) {
          alert('수도세 고지서는 사용기간(시작일/종료일)이 있어야 분배할 수 있습니다.\n고지서를 취소하고 사용기간을 채워 다시 등록해주세요.')
          setDistributing(null)
          return
        }

        const { data: rpcResult, error: rpcError } = await supabase
          .rpc('distribute_utility_bill', { p_bill_id: bill.id })

        if (rpcError) {
          alert('오류: ' + rpcError.message)
          setDistributing(null)
          return
        }
        if (!rpcResult?.success) {
          const errMap = {
            BILL_NOT_FOUND:      '고지서를 찾을 수 없습니다.',
            ALREADY_DISTRIBUTED: '이미 배분된 고지서입니다.',
            BILL_CANCELLED:      '취소된 고지서입니다.',
            NO_RESIDENTS:        '사용기간과 겹치는 거주 세대가 없습니다.',
            PERIOD_REQUIRED:     '수도세 고지서는 사용기간이 필요합니다.',
          }
          alert('⚠ ' + (errMap[rpcResult?.error] || rpcResult?.error || '알 수 없는 오류'))
          setDistributing(null)
          return
        }

        // 거주일수 가중 배분이라 인원수만으로 미리보기 계산이 불가능 — 결과를 다시 조회해서 보여줌
        const { data: rows } = await supabase
          .from('charge_details')
          .select('amount, monthly_charges(tenant_id, tenants(name, move_in_date, move_out_date, units(unit_no)))')
          .eq('source_bill_id', bill.id)

        const typeLabel = expenseTypes.find(t => t.code === bill.expense_type_code)?.label || bill.expense_type_code
        const preview = (rows || [])
          .map(r => {
            const t = r.monthly_charges?.tenants
            const outTag = t?.move_out_date ? ` (퇴거 ${t.move_out_date})` : ''
            return `  ${t?.units?.unit_no || '?'} ${t?.name || '?'}${outTag} → ${fmtNum(r.amount)}원`
          })
          .join('\n')

        const creditUsage = rpcResult.credit_usage || []
        const creditLines = creditUsage
          .map(c => {
            const row = (rows || []).find(r => r.monthly_charges?.tenant_id === c.tenant_id)
            const t = row?.monthly_charges?.tenants
            const label = t ? `${t.units?.unit_no || '?'} ${t.name || '?'}` : c.tenant_id
            const tag = c.from_reservation ? '(퇴거 보류금)' : '(선납금)'
            const settled = c.reservation_settled ? ' · 정산완료' : ''
            const shortfallStr = c.shortfall > 0 ? ` · 부족 ${fmtNum(c.shortfall)}원 미수` : ''
            return `  ${label} ${tag} ${fmtNum(c.applied)}원 자동충당${settled}${shortfallStr}`
          })
          .join('\n')

        alert(
          `✓ ${typeLabel} (${fmt(bill.total_amount)}) → ${(rows || []).length}개 세대 분배 완료 (거주일수 가중)\n\n${preview}` +
          (creditLines ? `\n\n💧 선납금 자동 충당:\n${creditLines}` : '')
        )
      } else {
        // 그 외 항목(정화조 등): 기존 인원수 균등분배 그대로
        const [{ data: charges }, { data: allActive }] = await Promise.all([
          supabase.from('monthly_charges')
            .select('id, tenant_id, tenants(name, residents, units(unit_no))')
            .eq('billing_month', bill.billed_month),
          supabase.from('tenants').select('id')
            .or(`move_out_date.is.null,move_out_date.gte.${bill.billed_month}`),
        ])

        if (!charges || charges.length === 0) {
          alert('해당 월의 청구 내역이 없습니다.\n대시보드 → "이번 달 청구 생성"을 먼저 실행해주세요.')
          setDistributing(null)
          return
        }

        const activeCount = allActive?.length || 0
        if (activeCount > 0 && charges.length < activeCount) {
          const missing = activeCount - charges.length
          const ok = confirm(
            `⚠ ${activeCount}개 호실 중 ${charges.length}개에만 청구 내역이 있습니다 (${missing}개 누락).\n` +
            `대시보드 → "이번 달 청구 생성"을 먼저 실행하는 것을 권장합니다.\n\n` +
            `지금 ${charges.length}개 호실에만 분배하시겠습니까?`
          )
          if (!ok) { setDistributing(null); return }
        }

        const totalResidents = charges.reduce((s, c) => s + (c.tenants?.residents || 0), 0)
        if (totalResidents === 0) { alert('거주인원 정보가 없습니다.'); setDistributing(null); return }

        const perPerson = Math.floor(Number(bill.total_amount) / totalResidents)
        const sorted = [...charges].sort((a, b) => (b.tenants?.residents || 0) - (a.tenants?.residents || 0))

        const { data: rpcResult, error: rpcError } = await supabase
          .rpc('distribute_utility_bill', { p_bill_id: bill.id })

        if (rpcError) {
          alert('오류: ' + rpcError.message)
          setDistributing(null)
          return
        }
        if (!rpcResult?.success) {
          const errMap = {
            BILL_NOT_FOUND:      '고지서를 찾을 수 없습니다.',
            ALREADY_DISTRIBUTED: '이미 배분된 고지서입니다.',
            BILL_CANCELLED:      '취소된 고지서입니다.',
            NO_RESIDENTS:        '거주인원 정보가 없습니다.',
          }
          alert('⚠ ' + (errMap[rpcResult?.error] || rpcResult?.error || '알 수 없는 오류'))
          setDistributing(null)
          return
        }

        const typeLabel = expenseTypes.find(t => t.code === bill.expense_type_code)?.label || bill.expense_type_code
        const preview = sorted
          .map(c => `  ${c.tenants?.units?.unit_no || '?'} ${c.tenants?.name || '?'} ${c.tenants?.residents || 0}인 → ${fmtNum(perPerson * (c.tenants?.residents || 0))}원`)
          .join('\n')
        alert(`✓ ${typeLabel} (${fmt(bill.total_amount)}) → ${charges.length}개 호실 분배 완료\n1인당 ${fmt(perPerson)} × ${totalResidents}명\n\n${preview}`)
      }
    } catch (e) {
      alert('오류: ' + e.message)
    }
    setDistributing(null)
    await loadData()
  }

  async function addExpenseType() {
    if (!typeForm.code || !typeForm.label) { alert('코드와 이름을 입력해주세요.'); return }
    const { error } = await supabase.from('expense_types').insert({
      code: typeForm.code.toUpperCase(),
      label: typeForm.label,
      split_method: 'BY_RESIDENTS',
    })
    if (error) { alert('오류: ' + error.message); return }
    setTypeForm({ code: '', label: '' })
    setShowTypeForm(false)
    await loadData()
  }

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - i)
    return format(d, 'yyyy-MM-01')
  })

  // 폼에서 실시간 사용량 비교
  const formPrev = prevBillInForm()
  const formUsageDiff = form.usage_amount && formPrev
    ? calcUsageDiff(form.usage_amount, formPrev.usage_amount, form.usage_unit)
    : null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-800">🧾 공동관리비</h2>
        {activeTab === 'bills' && (
          <div className="flex gap-2">
            <button onClick={() => setShowTypeForm(v => !v)} className="text-sm border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg">항목 추가</button>
            <button onClick={() => setShowForm(v => !v)} className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg">고지서 입력</button>
          </div>
        )}
      </div>

      {/* 탭 바 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
        {[['bills', '고지서'], ['settlement', '정산'], ['notifications', '알림설정'], ['history', '발송이력']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === key ? 'bg-white shadow text-gray-800' : 'text-gray-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'settlement' && <Settlement />}
      {activeTab === 'notifications' && <NotificationSettings />}
      {activeTab === 'history' && <NotificationHistory />}

      {/* 고지서 탭 컨텐츠 */}
      {activeTab === 'bills' && <>

      {/* 비용 항목 추가 폼 */}
      {showTypeForm && (
        <div className="bg-white rounded-xl shadow-sm p-4 space-y-3 border border-blue-100">
          <h3 className="font-semibold text-gray-700">새 관리비 항목</h3>
          <input placeholder="코드 (예: SEWER)" value={typeForm.code} onChange={e => setTypeForm(f => ({ ...f, code: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          <input placeholder="이름 (예: 정화조)" value={typeForm.label} onChange={e => setTypeForm(f => ({ ...f, label: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          <button onClick={addExpenseType} className="w-full bg-gray-800 text-white py-2 rounded-lg text-sm">저장</button>
        </div>
      )}

      {/* 고지서 입력 폼 */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm p-4 space-y-3 border border-blue-100">
          <h3 className="font-semibold text-gray-700">고지서 입력 (저장만 — 분배는 별도 "분배하기" 버튼)</h3>
          <div>
            <label className="text-xs text-gray-500 block mb-1">항목</label>
            <select value={form.expense_type_code} onChange={e => setForm(f => ({ ...f, expense_type_code: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {expenseTypes.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">청구 월</label>
            <select value={form.billed_month} onChange={e => setForm(f => ({ ...f, billed_month: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {months.map(m => <option key={m} value={m}>{m.slice(0, 7)}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">
                고지서 기간 시작{form.expense_type_code === 'WATER' && <span className="text-red-500"> *필수</span>}
              </label>
              <input type="date" value={form.period_start} onChange={e => setForm(f => ({ ...f, period_start: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">
                고지서 기간 종료{form.expense_type_code === 'WATER' && <span className="text-red-500"> *필수</span>}
              </label>
              <input type="date" value={form.period_end} onChange={e => setForm(f => ({ ...f, period_end: e.target.value }))} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          {form.expense_type_code === 'WATER' && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
              수도세는 이 사용기간과 겹치는 거주일수 기준으로 세대별(퇴거·입주 포함) 자동 배분됩니다.
            </p>
          )}
          <div>
            <label className="text-xs text-gray-500 block mb-1">총 금액 (원)</label>
            <input type="number" value={form.total_amount} onChange={e => setForm(f => ({ ...f, total_amount: e.target.value }))} placeholder="223940" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" inputMode="numeric" />
          </div>

          {/* 세대별 감면 (예: 다자녀 수도세 감면) */}
          <div className="space-y-2 border-t border-gray-100 pt-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-500">세대별 감면 (선택 · 다자녀 감면 등)</label>
              <button type="button" onClick={addDiscountRow} className="text-xs text-blue-600 font-medium">+ 감면 추가</button>
            </div>
            {form.discounts.length > 0 && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                위 총 금액은 <b>감면 적용 전(전체) 금액</b>으로 입력하세요. 인원수 기준으로 균등분배한 뒤, 아래 지정한 세대에서만 감면액을 자동으로 뺍니다.
              </p>
            )}
            {form.discounts.map((d, i) => (
              <div key={i} className="flex gap-1.5 items-center bg-gray-50 rounded-lg p-2">
                <select
                  value={d.tenant_id}
                  onChange={e => updateDiscountRow(i, { tenant_id: e.target.value })}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm bg-white"
                >
                  <option value="">세대 선택</option>
                  {tenants.map(t => <option key={t.id} value={t.id}>{t.units?.unit_no} {t.name}</option>)}
                </select>
                <input
                  type="number"
                  value={d.amount}
                  onChange={e => updateDiscountRow(i, { amount: e.target.value })}
                  placeholder="감면액"
                  className="w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
                  inputMode="numeric"
                />
                <input
                  type="text"
                  value={d.reason}
                  onChange={e => updateDiscountRow(i, { reason: e.target.value })}
                  placeholder="사유(선택)"
                  className="w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm"
                />
                <button type="button" onClick={() => removeDiscountRow(i)} className="text-red-400 text-sm px-1 shrink-0">✕</button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">사용량 (선택)</label>
              <input type="number" value={form.usage_amount} onChange={e => setForm(f => ({ ...f, usage_amount: e.target.value }))} placeholder="2.25" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">단위</label>
              <input type="text" value={form.usage_unit} onChange={e => setForm(f => ({ ...f, usage_unit: e.target.value }))} placeholder="㎥" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          {/* 실시간 사용량 비교 */}
          {formUsageDiff && (
            <div className={`rounded-lg px-3 py-2 text-xs ${formUsageDiff.cls}`}>
              <div>{formUsageDiff.label}</div>
              {formUsageDiff.warning && <div className="font-semibold mt-0.5">{formUsageDiff.warning}</div>}
            </div>
          )}
          <div>
            <label className="text-xs text-gray-500 block mb-1">영수증 첨부 (선택)</label>
            <input
              ref={receiptFileRef}
              type="file"
              className="hidden"
              accept="image/*,.pdf"
              onChange={e => setReceiptFile(e.target.files[0] || null)}
            />
            <button
              type="button"
              onClick={() => receiptFileRef.current.click()}
              className="w-full border-2 border-dashed border-gray-200 text-gray-500 py-2 rounded-lg text-sm hover:border-blue-300 hover:text-blue-500"
            >
              {receiptFile ? `✓ ${receiptFile.name}` : '영수증 파일 첨부 (선택)'}
            </button>
          </div>
          <button onClick={addBill} className="w-full bg-blue-600 text-white py-2.5 rounded-lg font-medium">저장 (분배는 카드에서 따로)</button>
        </div>
      )}

      {/* 고지서 목록 */}
      {loading ? (
        <div className="text-center py-8 text-gray-400">불러오는 중...</div>
      ) : bills.length === 0 ? (
        <div className="text-center py-8 text-gray-400">고지서가 없습니다.</div>
      ) : (
        <div className="space-y-3">
          {bills.map(b => {
            const typeLabel = expenseTypes.find(t => t.code === b.expense_type_code)?.label || b.expense_type_code
            const isOpen = selectedBillId === b.id
            // distributed_at 컬럼이 없어도 동작하도록 billRows 유무로 fallback
            const distributed = !!(b.distributed_at || (isOpen && billRows.length > 0))
            const prev = prevBillFor(b)
            const usageDiff = b.usage_amount != null && prev ? calcUsageDiff(b.usage_amount, prev.usage_amount, b.usage_unit) : null
            const distTimeStr = b.distributed_at ? b.distributed_at.slice(0, 16).replace('T', ' ') : null

            return (
              <div key={b.id} className={`bg-white rounded-xl shadow-sm overflow-hidden ${b.cancelled_at ? 'opacity-50' : ''}`}>
                {/* 고지서 요약 — 분배 완료 시 클릭으로 상세 토글 */}
                <div
                  className={`w-full text-left p-4 ${!b.cancelled_at ? 'cursor-pointer' : 'cursor-default'}`}
                  onClick={() => toggleDetail(b)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-gray-800">{typeLabel}</span>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">{b.billed_month?.slice(0, 7)}</span>
                        {b.cancelled_at
                          ? <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded">취소됨</span>
                          : distributed
                            ? <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">분배 완료 {distTimeStr}</span>
                            : <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded font-medium">미분배</span>
                        }
                        {b.corrects_bill_id && <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">정정본</span>}
                        {!b.cancelled_at && <span className="text-xs text-gray-400">{isOpen ? '▲' : '▼'}</span>}
                      </div>
                      <div className="text-2xl font-bold text-gray-800 mt-1">{fmt(b.total_amount)}</div>
                      {b.usage_amount != null && (
                        <div className="text-sm text-gray-500">
                          사용량: {b.usage_amount}{b.usage_unit}
                          {b.period_start && b.period_end && ` (${b.period_start} ~ ${b.period_end})`}
                        </div>
                      )}
                      {/* 카드에서도 직전 대비 표시 */}
                      {usageDiff && (
                        <div className={`mt-1 rounded px-2 py-1 text-xs inline-block ${usageDiff.cls}`}>
                          {usageDiff.label}
                          {usageDiff.warning && <span className="ml-1 font-semibold">{usageDiff.warning}</span>}
                        </div>
                      )}
                      {/* 세대별 감면 배지 */}
                      {billDiscounts[b.id]?.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {billDiscounts[b.id].map(d => (
                            <span key={d.id} className="text-xs bg-purple-50 text-purple-700 px-2 py-0.5 rounded">
                              {d.tenants?.units?.unit_no} {d.tenants?.name} 감면 -{fmtNum(d.amount)}원{d.reason ? ` (${d.reason})` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="text-xs text-gray-400 mt-1">{b.profiles?.name || b.profiles?.email}이 입력</div>
                    </div>
                    <div className="flex flex-col gap-2 ml-3" onClick={e => e.stopPropagation()}>
                      {b.receipt_path && (
                        <button
                          onClick={async () => {
                            const { data } = await supabase.storage.from('utility-bills').createSignedUrl(b.receipt_path, 60)
                            if (data?.signedUrl) window.open(data.signedUrl)
                          }}
                          className="text-xs text-blue-600 border border-blue-200 px-3 py-1.5 rounded-lg whitespace-nowrap"
                        >
                          영수증 보기
                        </button>
                      )}
                      {!b.cancelled_at && !distributed && (
                        <button
                          onClick={() => distributeBill(b)}
                          disabled={distributing === b.id}
                          className="text-xs bg-green-600 text-white px-3 py-1.5 rounded-lg disabled:opacity-50 whitespace-nowrap"
                        >
                          {distributing === b.id ? '분배 중...' : '분배하기'}
                        </button>
                      )}
                      {!b.cancelled_at && (
                        <button onClick={() => cancelBill(b)} className="text-xs border border-red-200 text-red-500 px-3 py-1.5 rounded-lg">취소</button>
                      )}
                    </div>
                  </div>
                </div>

                {/* 세대별 분담 내역 — 분배 완료 후에만 */}
                {isOpen && (
                  <div className="border-t border-gray-100 px-4 pb-4">
                    <div className="flex items-center justify-between py-2">
                      <h4 className="text-sm font-semibold text-gray-700">세대별 분담 내역</h4>
                      {billRows.length > 0 && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => copyBillText(b)}
                            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${copyFeedback === b.id ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}
                          >
                            {copyFeedback === b.id ? '✓ 복사됨' : '복사'}
                          </button>
                          <button
                            onClick={() => generateImage(b)}
                            disabled={generating}
                            className="text-xs px-3 py-1.5 rounded-lg font-medium bg-blue-600 text-white disabled:opacity-50"
                          >
                            {generating ? '생성 중...' : '문서 생성'}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* 상세 화면 상단에도 사용량 비교 */}
                    {usageDiff && (
                      <div className={`mb-3 rounded-lg px-3 py-2 text-xs ${usageDiff.cls}`}>
                        {usageDiff.label}
                        {usageDiff.warning && <div className="font-semibold mt-0.5">{usageDiff.warning}</div>}
                      </div>
                    )}

                    {detailLoading ? (
                      <div className="text-center py-4 text-gray-400 text-sm">불러오는 중...</div>
                    ) : billRows.length === 0 ? (
                      <div className="text-center py-4 text-gray-400 text-sm">데이터가 없습니다.</div>
                    ) : (
                      <>
                        <div>
                          <div className="grid grid-cols-4 gap-2 text-xs text-gray-400 pb-1 border-b border-gray-100 mb-1">
                            <span>호실</span><span>이름</span><span className="text-center">인원</span><span className="text-right">분담금</span>
                          </div>
                          {billRows.map((r, i) => {
                            const discount = billDiscounts[b.id]?.find(d => d.tenant_id === r.tenantId)
                            return (
                              <div key={i} className="grid grid-cols-4 gap-2 text-sm py-1.5 border-b border-gray-50">
                                <span className="font-medium text-gray-800">{r.unit_no}</span>
                                <span className="text-gray-600">
                                  {r.name}
                                  {discount && (
                                    <span className="ml-1 text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">
                                      -{fmtNum(discount.amount)} 감면
                                    </span>
                                  )}
                                </span>
                                <span className="text-center text-gray-600">{r.residents}인</span>
                                <span className="text-right font-semibold text-gray-800">{fmtNum(r.amount)}원</span>
                              </div>
                            )
                          })}
                        </div>
                        {(() => {
                          const totalR = billRows.reduce((s, r) => s + r.residents, 0)
                          const totalA = billRows.reduce((s, r) => s + r.amount, 0)
                          const perP = totalR > 0 ? Math.round(totalA / totalR) : 0
                          const diff = Number(b.total_amount) - totalA
                          return (
                            <div className="mt-2 pt-2 border-t border-gray-200 space-y-1">
                              <div className="flex justify-between text-sm font-bold text-gray-800">
                                <span>계 · {totalR}인</span><span>{fmtNum(totalA)}원</span>
                              </div>
                              <div className="flex justify-between text-xs text-gray-500">
                                <span>세대수</span><span>{billRows.length}개 호실</span>
                              </div>
                              <div className="flex justify-between text-xs text-gray-500">
                                <span>1인당 단가</span><span>{fmtNum(perP)}원</span>
                              </div>
                              {diff !== 0 && (
                                <div className="flex justify-between text-xs text-orange-500">
                                  <span>고지서 총액 대비 차액</span>
                                  <span>{diff > 0 ? '+' : ''}{fmtNum(diff)}원</span>
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      </>}  {/* end activeTab === 'bills' */}
    </div>
  )
}

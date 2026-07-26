import { fmtNum } from './fmt'
import { EXPENSE_LABEL } from './expenseTypes'

// outstanding 금액 기준으로 미납 항목만 추려냄 (RENT 우선 납부 가정)
function filterUnpaidItems(items, outstanding) {
  if (!items || items.length === 0) return []
  const total = items.reduce((s, i) => s + Number(i.amount), 0)
  const paid = total - outstanding
  if (paid <= 0) return items

  const sorted = [...items].sort((a, b) => {
    if (a.code === 'RENT') return -1
    if (b.code === 'RENT') return 1
    return Number(b.amount) - Number(a.amount)
  })

  let rem = paid
  const unpaid = []
  for (const item of sorted) {
    const amt = Number(item.amount)
    if (rem >= amt) { rem -= amt; continue }
    unpaid.push(rem > 0 ? { ...item, amount: amt - rem } : item)
    rem = 0
  }
  return unpaid
}

// 전체 연체 월에서 미납 항목명을 중복 없이 순서대로 수집
function getUnpaidItemNames(overdueMonths) {
  const seen = new Set()
  const names = []
  for (const m of overdueMonths) {
    const unpaid = filterUnpaidItems(m.items || [], m.outstanding)
    for (const item of unpaid) {
      const key = item.code || item.label
      if (!seen.has(key)) {
        seen.add(key)
        names.push(EXPENSE_LABEL[item.code] || item.label || item.code)
      }
    }
  }
  return names.length > 0 ? names : ['임대료']
}

// tenant: { name, payment_day, units: { unit_no } }
// overdueMonths: [{ billing_month: 'yyyy-MM-01', outstanding: number, items: [{code, label, amount}] }]
//   billing_month 오름차순 정렬 상태로 전달
// upcomingItems: null | { billing_month: 'yyyy-MM-01', nonRentItems: [{label, amount}] }
export function buildOverdueSms(tenant, overdueMonths, upcomingItems = null) {
  const name = tenant.name || ''
  const unitNo = tenant.units?.unit_no || ''
  const paymentDay = tenant.payment_day
  const itemLabel = getUnpaidItemNames(overdueMonths).join(', ')
  const lines = [
    `${name}님, ${unitNo} ${itemLabel} 납부일(${paymentDay}일)이 지나 안내드립니다.`,
    '',
  ]

  for (const month of overdueMonths) {
    const ym = month.billing_month.slice(0, 7)
    const outstanding = Number(month.outstanding)
    const items = filterUnpaidItems(month.items || [], outstanding)

    if (items.length <= 1) {
      const label = items[0]?.label || '미납금'
      lines.push(`[${ym}] ${label} ${fmtNum(outstanding)}원 (미납)`)
    } else {
      const parts = items.map(i => `${i.label} ${fmtNum(i.amount)}원`)
      lines.push(`[${ym}] ${parts.join(' + ')} = ${fmtNum(outstanding)}원 (미납)`)
    }
  }

  if (overdueMonths.length > 1) {
    const total = overdueMonths.reduce((s, m) => s + Number(m.outstanding), 0)
    lines.push('', `총 미납액: ${fmtNum(total)}원`)
  }

  if (upcomingItems && upcomingItems.nonRentItems.length > 0) {
    const ym = upcomingItems.billing_month.slice(0, 7)
    const parts = upcomingItems.nonRentItems.map(i => `${i.label} ${fmtNum(i.amount)}원`)
    lines.push('', `참고: 이번 달(${ym}) 청구에는 ${parts.join(', ')}이 포함되어 있습니다.`)
  }

  return lines.join('\n')
}

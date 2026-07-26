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

export function getNotificationType(billingMonth, paymentDay) {
  const today = new Date()
  const todayDay = today.getDate()
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`
  const isOverdue =
    billingMonth < currentMonth ||
    (billingMonth === currentMonth && paymentDay != null && paymentDay < todayDay)
  return isOverdue ? 'OVERDUE' : 'PAYMENT_REMIND'
}

export function buildPaymentRemindMessage({ tenant, charge, details, settings }) {
  const unitNo = tenant.units?.unit_no || ''
  const paymentDay = tenant.payment_day
  const daysUntil = paymentDay - new Date().getDate()
  const lines = [
    `${tenant.name}님, 안녕하세요.`,
    `${unitNo} 이번 달 임대료 납부일(${paymentDay}일)이`,
    `${daysUntil}일 후입니다.`,
    '',
    `청구액: ${fmtNum(charge.total_amount)}원`,
  ]
  for (const d of details) {
    if (Number(d.amount) > 0) lines.push(`  - ${d.label || d.expense_type_code}: ${fmtNum(d.amount)}원`)
  }
  lines.push(
    '',
    `납부 계좌: ${settings?.bank_account || '(계좌번호 미설정)'}`,
    `문의: ${settings?.sender_phone || '(연락처 미설정)'}`,
  )
  return lines.join('\n')
}

export function buildOverdueAlimtalk({ tenant, overdueMonths, settings }) {
  const unitNo = tenant.units?.unit_no || ''
  const paymentDay = tenant.payment_day
  const totalOutstanding = overdueMonths.reduce((s, m) => s + m.outstanding, 0)
  const itemLabel = getUnpaidItemNames(overdueMonths).join(', ')
  const lines = [
    `안녕하세요, ${tenant.name}님.`,
    '',
    `${unitNo} ${itemLabel} 납부일(${paymentDay}일)이 지나 안내드립니다.`,
    '',
    `현재 미납 금액은 ${fmtNum(totalOutstanding)}원입니다.`,
    '',
  ]
  for (const m of overdueMonths) {
    lines.push(`• ${m.billing_month.slice(0, 7)} : ${fmtNum(m.outstanding)}원`)
    const unpaidItems = filterUnpaidItems(m.items || [], m.outstanding)
    for (const item of unpaidItems) {
      if (item.amount > 0) lines.push(`  - ${item.label}: ${fmtNum(item.amount)}원`)
    }
  }
  lines.push('')
  if (settings?.bank_account) lines.push(`납부 계좌: ${settings.bank_account}`)
  lines.push('혹시 이미 송금하셨다면 이 문자는 무시해 주세요.')
  lines.push(settings?.owner_name ? `감사합니다. - ${settings.owner_name}` : '감사합니다.')
  return lines.join('\n')
}

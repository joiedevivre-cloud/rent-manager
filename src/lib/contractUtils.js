import { parseISO, differenceInDays, addDays } from 'date-fns'

export function calcNextExpiry(tenant) {
  if (!tenant.contract_end) return null
  const endDate = parseISO(tenant.contract_end)
  const today = new Date()
  if (!tenant.auto_renew || endDate > today) return endDate
  const startDate = tenant.move_in_date ? parseISO(tenant.move_in_date) : null
  const durationDays = (startDate && startDate < endDate)
    ? differenceInDays(endDate, startDate)
    : 730
  if (durationDays <= 0) return endDate  // 잘못된 데이터로 무한루프 방지
  let effective = endDate
  while (effective <= today) effective = addDays(effective, durationDays)
  return effective
}

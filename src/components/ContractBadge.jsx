import { differenceInDays, parseISO } from 'date-fns'
import { calcNextExpiry } from '../lib/contractUtils'

export default function ContractBadge({ tenant }) {
  if (!tenant?.contract_end) return null
  const today = new Date()
  const endDate = parseISO(tenant.contract_end)
  const isPast = endDate < today
  if (!tenant.auto_renew && isPast)
    return <span className="ml-1 text-xs bg-red-200 text-red-800 px-1.5 py-0.5 rounded font-medium">계약만료 경과</span>
  const effectiveEnd = calcNextExpiry(tenant)
  if (!effectiveEnd) return null
  const d = differenceInDays(effectiveEnd, today)
  if (tenant.auto_renew) {
    if (d <= 60) return <span className="ml-1 text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">자동갱신 D-{d}</span>
    if (d <= 90) return <span className="ml-1 text-xs bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded font-medium">자동갱신 D-{d}</span>
    return null
  }
  if (d <= 30) return <span className="ml-1 text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">D-{d} 긴급</span>
  if (d <= 60) return <span className="ml-1 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">D-{d} 경고</span>
  if (d <= 90) return <span className="ml-1 text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-medium">D-{d} 주의</span>
  return null
}

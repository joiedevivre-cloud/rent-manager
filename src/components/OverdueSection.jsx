import { useState } from 'react'
import { buildOverdueSms } from '../lib/overdueMessage'
import { fmt } from '../lib/fmt'

// Props:
//   tenant: { name, units: { unit_no }, phone }
//   overdueMonths: [{ billing_month, outstanding, items: [{label, amount}] }]
//   upcomingItems?: { billing_month, nonRentItems: [{label, amount}] }
export default function OverdueSection({ tenant, overdueMonths, upcomingItems = null }) {
  const [copied, setCopied] = useState(false)

  if (!overdueMonths || overdueMonths.length === 0) return null

  const totalOverdue = overdueMonths.reduce((s, m) => s + Number(m.outstanding), 0)
  const message = buildOverdueSms(tenant, overdueMonths, upcomingItems)
  const phone = tenant.phone?.trim() || ''

  function handleCopy(e) {
    e.stopPropagation()
    navigator.clipboard.writeText(message).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div
      className="border-l-4 border-red-400 bg-red-50 rounded-r-xl p-3 space-y-2"
      onClick={e => e.stopPropagation()}
    >
      {/* 월별 미납 목록 */}
      <div className="space-y-0.5">
        {overdueMonths.map(m => (
          <div key={m.billing_month} className="flex justify-between text-sm">
            <span className="text-red-700 font-medium">{m.billing_month.slice(0, 7)}</span>
            <span className="font-semibold text-red-800">{fmt(m.outstanding)}</span>
          </div>
        ))}
        <div className="flex justify-between text-sm font-bold border-t border-red-200 pt-1 mt-1">
          <span className="text-red-800">총 미납</span>
          <span className="text-red-800">{fmt(totalOverdue)}</span>
        </div>
      </div>

      {/* 메시지 미리보기 (읽기 전용) */}
      <div className="bg-white rounded-lg p-3 text-sm text-gray-700 whitespace-pre-line border border-red-100 leading-relaxed">
        {message}
      </div>

      {/* 버튼 */}
      <div className="flex gap-2">
        <button
          onClick={handleCopy}
          className="flex-1 text-sm py-2 rounded-lg font-medium bg-white border border-red-200 text-red-700 hover:bg-red-50 transition-colors"
        >
          {copied ? '복사됨 ✓' : '복사'}
        </button>
        <a
          href={phone ? `sms:${phone}?body=${encodeURIComponent(message)}` : undefined}
          onClick={e => { e.stopPropagation(); if (!phone) e.preventDefault() }}
          className={`flex-1 text-sm py-2 rounded-lg font-medium text-center block ${
            phone
              ? 'bg-white border border-red-200 text-red-700 hover:bg-red-50 transition-colors'
              : 'bg-gray-50 text-gray-300 cursor-not-allowed border border-gray-100'
          }`}
        >
          💬 문자 보내기
        </a>
      </div>
    </div>
  )
}

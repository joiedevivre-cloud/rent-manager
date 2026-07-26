import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { supabase } from '../../lib/supabase'
import NotificationModal from '../../components/NotificationModal'

const STATUS = {
  SUCCESS: { label: '성공', cls: 'bg-green-100 text-green-700' },
  FAILED:  { label: '실패', cls: 'bg-red-100 text-red-700' },
  PENDING: { label: '미발송', cls: 'bg-gray-100 text-gray-600' },
}

const TYPE_LABEL = { PAYMENT_REMIND: '납부 안내', OVERDUE: '연체 안내' }

function toKST(utcStr) {
  if (!utcStr) return ''
  return new Date(utcStr).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
}

export default function NotificationHistory() {
  const MONTHS = Array.from({ length: 6 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    return format(d, 'yyyy-MM')
  })
  const [month, setMonth] = useState(format(new Date(), 'yyyy-MM'))
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [resendTenant, setResendTenant] = useState(null)

  useEffect(() => { loadLogs() }, [month])

  async function loadLogs() {
    setLoading(true)
    const from = month + '-01'
    const d = new Date(from + 'T00:00:00')
    const toStr = format(new Date(d.getFullYear(), d.getMonth() + 1, 0), 'yyyy-MM-dd')
    const { data } = await supabase
      .from('notification_logs')
      .select('*, tenants!tenant_id(name, units(unit_no))')
      .gte('sent_at', from + 'T00:00:00+09:00')
      .lte('sent_at', toStr + 'T23:59:59+09:00')
      .order('sent_at', { ascending: false })
    setLogs(data || [])
    setLoading(false)
  }

  async function openResend(tenantId) {
    const { data } = await supabase
      .from('tenants').select('*, units(unit_no)').eq('id', tenantId).single()
    setResendTenant(data)
  }

  return (
    <div className="space-y-4">
      {resendTenant && (
        <NotificationModal
          tenant={resendTenant}
          onClose={() => { setResendTenant(null); loadLogs() }}
        />
      )}

      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-600 shrink-0">발송 이력</span>
        <select
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
        >
          {MONTHS.map(m => (
            <option key={m} value={m}>{m.slice(0, 4)}년 {Number(m.slice(5, 7))}월</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-center py-8 text-gray-400">불러오는 중...</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-12 text-gray-400">이 달 발송 이력이 없습니다.</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <ul className="divide-y divide-gray-50">
            {logs.map(log => {
              const sc = STATUS[log.status] || STATUS.PENDING
              return (
                <li key={log.id} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-sm font-medium text-gray-500 w-12 shrink-0">
                        {log.tenants?.units?.unit_no}
                      </span>
                      <span className="text-sm text-gray-800 truncate">{log.tenants?.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">
                        {TYPE_LABEL[log.notification_type] || log.notification_type}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc.cls}`}>
                        {sc.label}
                      </span>
                      {log.status === 'FAILED' && (
                        <button
                          onClick={() => openResend(log.tenant_id)}
                          className="text-xs text-red-600 border border-red-200 px-2 py-0.5 rounded-lg"
                        >
                          재발송
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5 pl-14">
                    {toKST(log.sent_at)}
                    {log.error_message && ` · ${log.error_message}`}
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

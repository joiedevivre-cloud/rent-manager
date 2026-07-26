import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  getNotificationType,
  buildPaymentRemindMessage,
  buildOverdueAlimtalk,
} from '../lib/notificationTemplates'

export default function NotificationModal({ tenant, overdueMonths: propOverdueMonths, onClose }) {
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null) // null | 'success' | 'no_api_key' | 'error'
  const [errorMsg, setErrorMsg] = useState('')
  const [message, setMessage] = useState('')
  const [notifType, setNotifType] = useState(null)

  useEffect(() => { init() }, [])

  async function init() {
    const { data: settingsData } = await supabase
      .from('notification_settings').select('*').limit(1).maybeSingle()

    // 연체자 화면에서 overdueMonths를 직접 넘겨준 경우 — 항상 OVERDUE로 고정
    // DB 재조회 없이 전달된 데이터(items 포함)를 그대로 사용
    if (propOverdueMonths && propOverdueMonths.length > 0) {
      setNotifType('OVERDUE')
      setMessage(buildOverdueAlimtalk({ tenant, overdueMonths: propOverdueMonths, settings: settingsData }))
      setLoading(false)
      return
    }

    // overdueMonths 미전달 — DB에서 미납 청구 조회 후 타입 결정
    const { data: chargesData } = await supabase
      .from('monthly_charges_status')
      .select('id, billing_month, total_amount, outstanding')
      .eq('tenant_id', tenant.id)
      .gt('outstanding', 0)
      .order('billing_month', { ascending: false })

    // 연체 우선: 가장 오래된 미납 달 기준으로 타입 결정
    const oldestCharge = chargesData ? [...chargesData].sort((a, b) => a.billing_month.localeCompare(b.billing_month))[0] : null
    if (!oldestCharge) { setLoading(false); return }

    const type = getNotificationType(oldestCharge.billing_month, tenant.payment_day)
    setNotifType(type)

    let msg = ''
    if (type === 'PAYMENT_REMIND') {
      // 납부 안내: 최신 달(이번 달) 청구 기준
      const latestCharge = chargesData[0]
      const { data: latestDetails } = await supabase
        .from('charge_details')
        .select('expense_type_code, amount, expense_types(label)')
        .eq('charge_id', latestCharge.id)
      msg = buildPaymentRemindMessage({
        tenant,
        charge: latestCharge,
        details: latestDetails || [],
        settings: settingsData,
      })
    } else {
      // 연체 안내: 각 달마다 개별 items fetch
      const chargeIds = chargesData.map(c => c.id)
      const { data: allDetails } = await supabase
        .from('charge_details')
        .select('charge_id, expense_type_code, amount, expense_types(label)')
        .in('charge_id', chargeIds)

      const detailsMap = {}
      for (const d of (allDetails || [])) {
        if (!detailsMap[d.charge_id]) detailsMap[d.charge_id] = []
        detailsMap[d.charge_id].push({
          code: d.expense_type_code,
          label: d.expense_types?.label || d.expense_type_code,
          amount: Number(d.amount),
        })
      }

      const oMonths = chargesData
        .sort((a, b) => a.billing_month.localeCompare(b.billing_month))
        .map(c => ({ billing_month: c.billing_month, outstanding: Number(c.outstanding), items: detailsMap[c.id] || [] }))
      msg = buildOverdueAlimtalk({ tenant, overdueMonths: oMonths, settings: settingsData })
    }
    setMessage(msg)
    setLoading(false)
  }

  async function handleSend() {
    if (!tenant.phone) { alert('연락처가 등록되지 않은 세입자입니다.'); return }
    setSending(true)
    setResult(null)

    const { data: log } = await supabase
      .from('notification_logs')
      .insert({ tenant_id: tenant.id, notification_type: notifType, template_content: message, status: 'PENDING' })
      .select('id')
      .single()

    const { data: res, error } = await supabase.functions.invoke('send_alimtalk', {
      body: { phone: tenant.phone, message, notification_type: notifType },
    })

    const errMsg = res?.error || error?.message || null

    if (!res?.success) {
      if (errMsg === 'NO_API_KEY') {
        await supabase.from('notification_logs')
          .update({ error_message: 'API 키 미설정' })
          .eq('id', log.id)
        setResult('no_api_key')
      } else {
        await supabase.from('notification_logs')
          .update({ status: 'FAILED', error_message: errMsg })
          .eq('id', log.id)
        setErrorMsg(errMsg || '알 수 없는 오류')
        setResult('error')
      }
    } else {
      await supabase.from('notification_logs')
        .update({ status: 'SUCCESS', aligo_message_id: res.mid || null })
        .eq('id', log.id)
      setResult('success')
    }
    setSending(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-2xl mx-auto bg-white rounded-t-2xl px-4 pt-5 pb-8 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-800">알림톡 미리보기</h3>
          <button onClick={onClose} className="text-gray-400 p-1 text-lg">✕</button>
        </div>

        {loading ? (
          <div className="text-center py-10 text-gray-400">불러오는 중...</div>
        ) : !notifType ? (
          <div className="text-center py-10 space-y-2">
            <p className="text-3xl">✓</p>
            <p className="text-gray-600 font-medium">발송할 알림이 없습니다</p>
            <p className="text-sm text-gray-400">미납 청구가 없거나 납부 완료 상태입니다.</p>
            <button onClick={onClose} className="mt-2 w-full border border-gray-200 text-gray-600 py-3 rounded-xl text-sm font-medium">닫기</button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                notifType === 'PAYMENT_REMIND' ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
              }`}>
                {notifType === 'PAYMENT_REMIND' ? '납부 안내' : '연체 안내'}
              </span>
              <span className="text-sm text-gray-500">
                {tenant.units?.unit_no} {tenant.name}
                {tenant.phone ? ` · ${tenant.phone}` : <span className="text-red-400"> · 연락처 없음</span>}
              </span>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-gray-800 whitespace-pre-line leading-relaxed font-mono">
              {message}
            </div>

            {result === 'success' && (
              <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2.5 text-sm text-green-700">
                ✓ 알림톡이 발송되었습니다.
              </div>
            )}
            {result === 'no_api_key' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-sm text-amber-800">
                사업자 등록 후 알리고 API 키를 설정해주세요.<br />
                <span className="text-xs text-amber-600">발송 내역은 이력에 PENDING으로 저장됐습니다.</span>
              </div>
            )}
            {result === 'error' && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-sm text-red-700">
                발송 실패: {errorMsg}
              </div>
            )}

            {!result ? (
              <div className="flex gap-2 pt-1">
                <button onClick={onClose} className="flex-1 border border-gray-200 text-gray-600 py-3 rounded-xl text-sm font-medium">
                  취소
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending || !tenant.phone}
                  className={`flex-[2] py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50 ${
                    notifType === 'PAYMENT_REMIND' ? 'bg-blue-600' : 'bg-red-600'
                  }`}
                >
                  {sending ? '발송 중...' : !tenant.phone ? '연락처 없음' : '알림톡 발송'}
                </button>
              </div>
            ) : (
              <button onClick={onClose} className="w-full border border-gray-200 text-gray-600 py-3 rounded-xl text-sm font-medium">
                닫기
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

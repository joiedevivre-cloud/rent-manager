import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { format } from 'date-fns'
import { fmt } from '../../lib/fmt'

export default function Payments() {
  const { user } = useAuth()
  const [tenants, setTenants] = useState([])
  const [selectedTenant, setSelectedTenant] = useState(null)
  const [billingMonth, setBillingMonth] = useState(format(new Date(), 'yyyy-MM-01'))
  const [charge, setCharge] = useState(null)
  const [payments, setPayments] = useState([])
  const [form, setForm] = useState({ payment_date: format(new Date(), 'yyyy-MM-dd'), amount: '', memo: '계좌이체' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase
      .from('tenants')
      .select('id, name, payment_day, units(unit_no)')
      .is('move_out_date', null)
      .order('created_at')
      .then(({ data }) => setTenants(data || []))
  }, [])

  useEffect(() => {
    if (!selectedTenant) return
    loadCharge()
  }, [selectedTenant, billingMonth])

  async function loadCharge() {
    const [{ data: chargeData }, { data: rentRow }] = await Promise.all([
      supabase
        .from('monthly_charges_status')
        .select('*')
        .eq('tenant_id', selectedTenant)
        .eq('billing_month', billingMonth)
        .maybeSingle(),
      supabase
        .from('rent_history')
        .select('rent_amount')
        .eq('tenant_id', selectedTenant)
        .lte('effective_from', (() => {
          const bDate = new Date(billingMonth + 'T00:00:00')
          return format(new Date(bDate.getFullYear(), bDate.getMonth() + 1, 0), 'yyyy-MM-dd')
        })())
        .order('effective_from', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])
    setCharge(chargeData || null)

    // 기본 금액을 현재 유효한 월세로 세팅
    setForm(f => ({ ...f, amount: rentRow?.rent_amount ? String(rentRow.rent_amount) : '' }))

    if (chargeData) {
      const { data: payData } = await supabase
        .from('payment_history')
        .select('*, creator:profiles!created_by(name, email)')
        .eq('charge_id', chargeData.id)
        .order('payment_date', { ascending: false })
      setPayments(payData || [])
    } else {
      setPayments([])
    }
  }

  async function addPayment() {
    if (!charge) { alert('청구 내역이 없습니다. 대시보드에서 청구를 먼저 생성하세요.'); return }
    if (!form.amount || Number(form.amount) <= 0) { alert('금액을 입력해주세요.'); return }
    setSaving(true)
    const { error } = await supabase.from('payment_history').insert({
      charge_id: charge.id,
      payment_date: form.payment_date,
      amount: Number(form.amount),
      memo: form.memo || null,
      created_by: user.id,
    })
    if (error) {
      alert('오류: ' + error.message)
    } else {
      setForm(f => ({ ...f, payment_date: format(new Date(), 'yyyy-MM-dd') }))
      await loadCharge()
    }
    setSaving(false)
  }

  async function reversePayment(id) {
    if (!confirm('이 입금 내역을 취소하시겠습니까?')) return
    await supabase.from('payment_history').update({
      reversed_at: new Date().toISOString(),
      reversed_by: user.id,
    }).eq('id', id)
    await loadCharge()
  }

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date()
    d.setMonth(d.getMonth() - i)
    return format(d, 'yyyy-MM-01')
  })

  const selectedTenantName = tenants.find(t => t.id === selectedTenant)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-gray-800">💰 입금 확인</h2>

      {/* 호실 선택 */}
      <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
        <div>
          <label className="text-sm font-medium text-gray-600 block mb-1">호실 선택</label>
          <div className="grid grid-cols-2 gap-2">
            {tenants.map(t => (
              <button
                key={t.id}
                onClick={() => setSelectedTenant(t.id)}
                className={`py-3 px-3 rounded-xl text-left border-2 transition-colors ${
                  selectedTenant === t.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 bg-white'
                }`}
              >
                <div className="font-bold text-gray-800 text-base">{t.units?.unit_no}</div>
                <div className="text-sm text-gray-600">{t.name}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {t.payment_day ? `매월 ${t.payment_day}일` : '입금일 미정'}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-gray-600 block mb-1">청구 월</label>
          <select
            value={billingMonth}
            onChange={e => setBillingMonth(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-base"
          >
            {months.map(m => (
              <option key={m} value={m}>{m.slice(0, 7)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 청구 요약 */}
      {selectedTenant && (
        <div className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${
          !charge ? 'border-gray-300' :
          charge.status === '완납' ? 'border-green-500' :
          charge.status === '부분납' ? 'border-yellow-500' :
          'border-red-500'
        }`}>
          <div className="flex justify-between items-start mb-3">
            <div>
              <p className="text-sm text-gray-500">
                {selectedTenantName?.units?.unit_no} {selectedTenantName?.name}
                {selectedTenantName?.payment_day && (
                  <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                    매월 {selectedTenantName.payment_day}일
                  </span>
                )}
              </p>
              <p className="text-2xl font-bold text-gray-800 mt-1">{fmt(charge?.total_amount) || '청구 없음'}</p>
            </div>
            <span className={`text-sm px-3 py-1 rounded-full font-semibold ${
              !charge ? 'bg-gray-100 text-gray-500' :
              charge.status === '완납' ? 'bg-green-100 text-green-700' :
              charge.status === '부분납' ? 'bg-yellow-100 text-yellow-700' :
              'bg-red-100 text-red-700'
            }`}>
              {charge?.status || '청구없음'}
            </span>
          </div>
          {charge && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-gray-50 rounded-lg py-2">
                <p className="text-xs text-gray-400">총 청구</p>
                <p className="text-sm font-bold text-gray-700">{fmt(charge.total_amount)}</p>
              </div>
              <div className="bg-green-50 rounded-lg py-2">
                <p className="text-xs text-gray-400">납부</p>
                <p className="text-sm font-bold text-green-600">{fmt(charge.paid_amount)}</p>
              </div>
              <div className={`rounded-lg py-2 ${charge.outstanding > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                <p className="text-xs text-gray-400">미수금</p>
                <p className={`text-sm font-bold ${charge.outstanding > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                  {fmt(charge.outstanding)}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 입금 추가 폼 */}
      {selectedTenant && charge && (
        <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
          <h3 className="font-semibold text-gray-800 text-base">입금 추가</h3>
          <div>
            <label className="text-sm text-gray-600 block mb-1">입금일</label>
            <input
              type="date"
              value={form.payment_date}
              onChange={e => setForm(f => ({ ...f, payment_date: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-3 text-base"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600 block mb-1">금액 (원)</label>
            <input
              type="number"
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              placeholder="500000"
              className="w-full border border-gray-200 rounded-lg px-3 py-3 text-base"
              inputMode="numeric"
            />
          </div>
          <div>
            <label className="text-sm text-gray-600 block mb-1">메모 (선택)</label>
            <input
              type="text"
              value={form.memo}
              onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}
              placeholder="계좌이체 등"
              className="w-full border border-gray-200 rounded-lg px-3 py-3 text-base"
            />
          </div>
          <button
            onClick={addPayment}
            disabled={saving}
            className="w-full bg-blue-600 text-white py-4 rounded-xl text-lg font-bold disabled:opacity-50"
          >
            {saving ? '저장 중...' : '입금 확인 저장'}
          </button>
        </div>
      )}

      {/* 입금 이력 */}
      {payments.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="font-semibold text-gray-800">입금 이력</h3>
          </div>
          <ul className="divide-y divide-gray-50">
            {payments.map(p => (
              <li key={p.id} className={`px-4 py-3 ${p.reversed_at ? 'opacity-40' : ''}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`font-semibold text-base ${p.reversed_at ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                        {fmt(p.amount)}
                      </span>
                      {p.reversed_at && <span className="text-xs text-red-400">취소됨</span>}
                    </div>
                    <div className="text-sm text-gray-500">
                      {p.payment_date} · {p.creator?.name || p.creator?.email || '알 수 없음'}가 입력
                      {p.memo && <span> · {p.memo}</span>}
                    </div>
                  </div>
                  {!p.reversed_at && (
                    <button
                      onClick={() => reversePayment(p.id)}
                      className="text-xs text-red-500 border border-red-200 px-2 py-1 rounded-lg"
                    >
                      취소
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

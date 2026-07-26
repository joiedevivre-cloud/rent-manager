// =============================================================
// 세입자 상세 — 4탭: 계약 / 청구·입금 / 문서 / 연체
// =============================================================
import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { format } from 'date-fns'
import OverdueSection from '../../components/OverdueSection'
import NotificationModal from '../../components/NotificationModal'
import ContractBadge from '../../components/ContractBadge'
import { fmt } from '../../lib/fmt'

function ContactSheet({ tenant, latestCharge, onClose }) {
  const phone = tenant.phone?.trim()
  const hasPhone = !!phone
  const totalAmount = latestCharge ? Number(latestCharge.total_amount) : 0
  const month = latestCharge?.billing_month?.slice(0, 7) || format(new Date(), 'yyyy-MM')
  const message = `${tenant.name}님, ${month} 청구액은 ${totalAmount.toLocaleString('ko-KR')}원입니다. (납부 ${Number(latestCharge?.paid_amount || 0).toLocaleString('ko-KR')}원 / 미수 ${Number(latestCharge?.outstanding || totalAmount).toLocaleString('ko-KR')}원)`

  function sendKakao() {
    if (!window.Kakao?.isInitialized()) { alert('카카오 SDK 미설정'); return }
    window.Kakao.Share.sendDefault({
      objectType: 'text', text: message,
      link: { mobileWebUrl: window.location.origin, webUrl: window.location.origin },
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative w-full max-w-2xl mx-auto bg-white rounded-t-2xl px-4 pt-4 pb-8 space-y-2" onClick={e => e.stopPropagation()}>
        <div className="text-center pb-2">
          <p className="font-semibold text-gray-800">{tenant.units?.unit_no} {tenant.name}</p>
          {!hasPhone && <p className="text-xs text-red-400 mt-0.5">연락처 미등록</p>}
          {latestCharge && <p className="text-xs text-gray-500 mt-1">{month} · {fmt(totalAmount)} 청구</p>}
        </div>
        <a href={hasPhone ? `tel:${phone}` : undefined} onClick={!hasPhone ? e => e.preventDefault() : undefined}
          className={`flex items-center justify-center gap-2 w-full py-3.5 rounded-xl text-base font-medium ${hasPhone ? 'bg-blue-50 text-blue-700' : 'bg-gray-50 text-gray-300 cursor-not-allowed'}`}>
          📞 전화하기 {hasPhone && <span className="text-sm font-normal">{phone}</span>}
        </a>
        <a href={hasPhone ? `sms:${phone}?body=${encodeURIComponent(message)}` : undefined} onClick={!hasPhone ? e => e.preventDefault() : undefined}
          className={`flex items-center justify-center gap-2 w-full py-3.5 rounded-xl text-base font-medium ${hasPhone ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-300 cursor-not-allowed'}`}>
          💬 문자 보내기
        </a>
        <button onClick={sendKakao} className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl text-base font-medium bg-yellow-50 text-yellow-800">
          <span className="text-lg">🟡</span> 카카오톡 공유
        </button>
        <button onClick={onClose} className="w-full py-3.5 rounded-xl text-base font-medium text-gray-500 border border-gray-200">취소</button>
      </div>
    </div>
  )
}

// memo 필드 인코딩: "[월세]계좌이체(월세)" → { tag: '월세', text: '계좌이체(월세)' }
function parseMemo(memo) {
  if (!memo) return { tag: null, text: '' }
  const m = memo.match(/^\[([^\]]+)\](.*)$/)
  if (m) return { tag: m[1].trim(), text: m[2].trim() }
  return { tag: null, text: memo }
}

const PAY_TAG_CLS = {
  '월세':   'bg-blue-100 text-blue-700',
  '수도세': 'bg-green-100 text-green-700',
  '정화조': 'bg-orange-100 text-orange-700',
  '기타':   'bg-gray-100 text-gray-600',
}

function resolveChargeStatus(charge, paymentDay, billingMonth) {
  const today = new Date()
  const todayDay = today.getDate()
  const currentMonth = format(today, 'yyyy-MM-01')
  const isPastMonth = billingMonth < currentMonth
  if (!charge || Number(charge.total_amount) <= 0) return { label: '청구 전', cls: 'text-gray-500 bg-gray-100' }
  if (charge.status === '완납') return { label: '완납', cls: 'text-green-700 bg-green-100' }
  if (charge.status === '부분납') {
    if (isPastMonth) return { label: '부분납·연체', cls: 'text-orange-700 bg-orange-100' }
    return { label: '부분납', cls: 'text-yellow-700 bg-yellow-100' }
  }
  if (isPastMonth) return { label: '연체', cls: 'text-red-700 bg-red-100' }
  if (!paymentDay || paymentDay >= todayDay)
    return { label: paymentDay === todayDay ? '오늘' : '예정', cls: 'text-blue-600 bg-blue-100' }
  return { label: '연체', cls: 'text-red-700 bg-red-100' }
}

function ChargeCard({ charge, onPaymentAdded, userId, paymentDay }) {
  const [details, setDetails] = useState([])
  const [payments, setPayments] = useState([])
  const [open, setOpen] = useState(false)
  const [showPayForm, setShowPayForm] = useState(false)
  const [payForm, setPayForm] = useState({ amount: '', payment_date: format(new Date(), 'yyyy-MM-dd'), payType: '월세', memo: '계좌이체(월세)' })

  useEffect(() => { if (open) loadDetails() }, [open, charge.id])

  async function loadDetails() {
    const [{ data: d }, { data: p }] = await Promise.all([
      supabase.from('charge_details').select('*, expense_types(label)').eq('charge_id', charge.id),
      supabase.from('payment_history')
        .select('*, creator:profiles!created_by(name,email)')
        .eq('charge_id', charge.id).order('payment_date'),
    ])
    setDetails(d || [])
    setPayments(p || [])
  }

  async function addPayment() {
    if (!payForm.amount) { alert('금액을 입력하세요.'); return }
    const encodedMemo = payForm.payType
      ? `[${payForm.payType}]${payForm.memo || ''}`.trim()
      : payForm.memo || null
    const PAY_TYPE_TO_CODE = { '월세': 'RENT', '수도세': 'WATER', '정화조': 'SEPTIC', '기타': 'ETC' }
    const paymentType = PAY_TYPE_TO_CODE[payForm.payType] || null
    const { error } = await supabase.from('payment_history').insert({
      charge_id: charge.id,
      payment_date: payForm.payment_date,
      amount: Number(payForm.amount),
      memo: encodedMemo || null,
      payment_type: paymentType,
      created_by: userId,
    })
    if (error) { alert('저장 오류: ' + error.message); return }
    setShowPayForm(false)
    await loadDetails()
    onPaymentAdded?.()
  }

  async function reversePayment(paymentId) {
    if (!window.confirm('이 입금 건을 취소하시겠습니까?')) return
    const { error } = await supabase.from('payment_history')
      .update({ reversed_at: new Date().toISOString(), reversed_by: userId }).eq('id', paymentId)
    if (error) { alert('취소 오류: ' + error.message); return }
    await loadDetails()
    onPaymentAdded?.()
  }

  const outstanding = Number(charge.outstanding)
  const { label: statusLabel, cls: statusCls } = resolveChargeStatus(charge, paymentDay, charge.billing_month)

  const PAY_TYPE_CODE = { '월세': 'RENT', '수도세': 'WATER', '정화조': 'SEPTIC' }

  function amountForType(type) {
    const code = PAY_TYPE_CODE[type]
    if (!code) return null  // '기타' 또는 미선택
    const d = details.find(d => d.expense_type_code === code)
    return d ? Number(d.amount) : undefined  // undefined = 항목 없음
  }

  function openPayForm() {
    const rentAmt = amountForType('월세')
    setPayForm({
      payType: '월세',
      memo: '계좌이체(월세)',
      payment_date: format(new Date(), 'yyyy-MM-dd'),
      amount: rentAmt != null ? String(rentAmt) : '',
    })
    setShowPayForm(true)
  }

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <button onClick={() => setOpen(v => !v)} className="w-full px-4 py-3 flex items-center justify-between">
        <div className="text-left">
          <div className="font-semibold text-gray-800">{charge.billing_month?.slice(0, 7)}</div>
          <div className="text-sm text-gray-500">
            청구 {fmt(charge.total_amount)} · 납부 {fmt(charge.paid_amount)}
            {outstanding > 0 && <span className="text-red-500"> · 미수 {fmt(outstanding)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusCls}`}>{statusLabel}</span>
          <span className="text-gray-400">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-50">
          {Number(charge.total_amount) === 0 && (
            <div className="mt-2 text-xs text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
              ⚠ 월세 미등록으로 청구액 ₩0입니다. '계약' 탭의 월세 이력에서 추가해주세요.
            </div>
          )}
          <div className="space-y-1 pt-2">
            <p className="text-xs font-medium text-gray-500 uppercase">청구 항목</p>
            {details.length === 0 ? <p className="text-sm text-gray-400">항목 없음</p>
              : details.map(d => (
                <div key={d.id} className="flex justify-between text-sm">
                  <span className="text-gray-600">{d.expense_types?.label || d.expense_type_code}</span>
                  <span className="font-medium">{fmt(d.amount)}</span>
                </div>
              ))}
            <div className="flex justify-between text-sm font-bold border-t border-gray-100 pt-1">
              <span>합계</span><span>{fmt(charge.total_amount)}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-gray-500 uppercase">입금 이력</p>
            {payments.length === 0 ? <p className="text-sm text-gray-400">입금 기록 없음</p>
              : payments.map(p => {
                const { tag, text } = parseMemo(p.memo)
                return (
                <div key={p.id} className={`flex items-center gap-2 text-sm rounded-lg px-2 py-1.5 ${p.reversed_at ? 'bg-gray-50 opacity-50' : 'bg-green-50'}`}>
                  <div className={`flex-1 min-w-0 ${p.reversed_at ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                    <span className="font-medium">{fmt(p.amount)}</span>
                    <span className="text-xs text-gray-400 ml-1.5">{p.payment_date}</span>
                    {tag && (
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ml-1.5 ${PAY_TAG_CLS[tag] ?? 'bg-gray-100 text-gray-600'}`}>
                        {tag}
                      </span>
                    )}
                    {text && <span className="text-xs text-gray-400 ml-1">· {text}</span>}
                    <span className="text-xs text-gray-300 ml-1">· {p.creator?.name || p.creator?.email || '?'}</span>
                    {p.reversed_at && <span className="text-xs text-red-400 ml-1">(취소됨)</span>}
                  </div>
                  {!p.reversed_at && (
                    <button onClick={() => reversePayment(p.id)}
                      className="text-xs text-red-500 border border-red-200 px-2 py-0.5 rounded shrink-0 hover:bg-red-50">
                      취소
                    </button>
                  )}
                </div>
              )})}
          </div>

          {outstanding > 0 && (
            showPayForm ? (
              <div className="space-y-2 p-3 bg-green-50 rounded-lg border border-green-200">
                <p className="text-xs text-green-800 font-semibold">{charge.billing_month?.slice(0, 7)} 입금 등록</p>

                {/* 입금 구분 → 금액 자동 채움 */}
                <select
                  value={payForm.payType}
                  onChange={e => {
                    const t = e.target.value
                    const amt = amountForType(t)
                    setPayForm(f => ({
                      ...f,
                      payType: t,
                      memo: t && t !== '기타' ? `계좌이체(${t})` : t === '기타' ? '계좌이체(기타)' : '',
                      amount: amt != null ? String(amt) : '',
                    }))
                  }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">구분 선택 안함</option>
                  {['월세', '수도세', '정화조', '기타'].map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>

                {/* 선택한 구분이 이번 달 청구에 없을 때 안내 */}
                {payForm.payType && payForm.payType !== '기타' && PAY_TYPE_CODE[payForm.payType] &&
                  amountForType(payForm.payType) === undefined && (
                  <p className="text-xs text-amber-600">이번 달 {payForm.payType} 항목이 청구에 없습니다</p>
                )}

                <input type="number" value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="입금액" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                <input type="date" value={payForm.payment_date} onChange={e => setPayForm(f => ({ ...f, payment_date: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                <input type="text" value={payForm.memo} onChange={e => setPayForm(f => ({ ...f, memo: e.target.value }))}
                  placeholder="메모(선택 · 직접 수정 가능)" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                <div className="flex gap-2">
                  <button onClick={() => setShowPayForm(false)} className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm">취소</button>
                  <button onClick={addPayment} className="flex-1 bg-green-600 text-white py-2 rounded-lg text-sm font-medium">저장</button>
                </div>
              </div>
            ) : (
              <button onClick={openPayForm}
                className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-medium">
                + 입금 추가 ({fmt(outstanding)} 미수)
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

const WATER_ENTRY_LABEL = { DEPOSIT: '입금', ADJUSTMENT: '조정', REFUND: '환급' }
const WATER_ENTRY_CLS = {
  DEPOSIT: 'bg-blue-100 text-blue-700',
  ADJUSTMENT: 'bg-purple-100 text-purple-700',
  REFUND: 'bg-gray-100 text-gray-600',
}

function WaterCreditCard({ tenantId, userId }) {
  const [balance, setBalance] = useState(null)
  const [entries, setEntries] = useState([])
  const [usages, setUsages] = useState([])
  const [reservation, setReservation] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [showUsages, setShowUsages] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    entry_type: 'DEPOSIT', amount: '', memo: '', deposit_date: format(new Date(), 'yyyy-MM-dd'),
  })

  useEffect(() => { load() }, [tenantId])

  async function load() {
    const [{ data: bal }, { data: ent }, { data: use }, { data: res }] = await Promise.all([
      supabase.from('tenant_water_credit_balances').select('*').eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('tenant_water_credits').select('*').eq('tenant_id', tenantId).order('deposit_date', { ascending: false }),
      supabase.from('tenant_water_credit_usages')
        .select('*, monthly_charges(billing_month)')
        .eq('tenant_id', tenantId).order('created_at', { ascending: false }),
      supabase.from('tenant_water_credit_reservations')
        .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    setBalance(bal || { total_balance: 0, reserved_balance: 0, available_balance: 0 })
    setEntries(ent || [])
    setUsages(use || [])
    setReservation(res || null)
  }

  async function addEntry() {
    if (!form.amount || Number(form.amount) === 0) { alert('금액을 입력하세요.'); return }
    setSaving(true)
    const amt = Number(form.amount)
    const signedAmount = form.entry_type === 'REFUND' ? -Math.abs(amt) : amt
    const { error } = await supabase.from('tenant_water_credits').insert({
      tenant_id: tenantId,
      entry_type: form.entry_type,
      amount: signedAmount,
      memo: form.memo || null,
      deposit_date: form.deposit_date,
      created_by: userId,
    })
    setSaving(false)
    if (error) { alert('저장 오류: ' + error.message); return }
    setShowForm(false)
    setForm({ entry_type: 'DEPOSIT', amount: '', memo: '', deposit_date: format(new Date(), 'yyyy-MM-dd') })
    await load()
  }

  async function reverseEntry(entryId) {
    if (!window.confirm('이 선납금 기록을 취소하시겠습니까?')) return
    const { error } = await supabase.from('tenant_water_credits')
      .update({ reversed_at: new Date().toISOString(), reversed_by: userId })
      .eq('id', entryId)
    if (error) { alert('취소 오류: ' + error.message); return }
    await load()
  }

  if (!balance) return null

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-700 text-sm">💧 수도세 선납금</h3>
        <button onClick={() => setShowForm(v => !v)} className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg">
          {showForm ? '닫기' : '+ 입금/조정'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-gray-50 rounded-lg py-2">
          <p className="text-xs text-gray-400">총 잔액</p>
          <p className="text-sm font-bold text-gray-800">{fmt(balance.total_balance)}</p>
        </div>
        <div className="bg-purple-50 rounded-lg py-2">
          <p className="text-xs text-gray-400">예약(보류)</p>
          <p className="text-sm font-bold text-purple-700">{fmt(balance.reserved_balance)}</p>
        </div>
        <div className="bg-blue-50 rounded-lg py-2">
          <p className="text-xs text-gray-400">가용 잔액</p>
          <p className="text-sm font-bold text-blue-700">{fmt(balance.available_balance)}</p>
        </div>
      </div>

      {reservation && !reservation.released_at && (
        <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-800">
          퇴거({reservation.move_out_date_snapshot}) 수도세 정산 대기 — 보류 원금 {fmt(reservation.amount)}
          {reservation.refund_account && <span className="block mt-0.5 text-purple-600">환급 계좌: {reservation.refund_account}</span>}
          {reservation.refund_memo && <span className="block text-purple-600">메모: {reservation.refund_memo}</span>}
        </div>
      )}
      {reservation?.released_at && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-800">
          퇴거 수도세 정산 완료 ({reservation.released_at.slice(0, 10)})
        </div>
      )}

      {showForm && (
        <div className="space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <select value={form.entry_type} onChange={e => setForm(f => ({ ...f, entry_type: e.target.value }))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white">
            <option value="DEPOSIT">입금 (선납금 받음)</option>
            <option value="ADJUSTMENT">조정 (금액 보정 · 음수 가능)</option>
            <option value="REFUND">환급 (수동 환급 처리)</option>
          </select>
          <input type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
            placeholder={form.entry_type === 'ADJUSTMENT' ? '금액 (음수 가능, 예: -5000)' : '금액'}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          <input type="date" value={form.deposit_date} onChange={e => setForm(f => ({ ...f, deposit_date: e.target.value }))}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          <input type="text" value={form.memo} onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}
            placeholder="메모(선택)" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          <button onClick={addEntry} disabled={saving} className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50">
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-500 uppercase">입금·조정·환급 내역</p>
        {entries.length === 0 ? <p className="text-sm text-gray-400">기록 없음</p> : (
          entries.map(e => (
            <div key={e.id} className={`flex items-center gap-2 text-sm rounded-lg px-2 py-1.5 ${e.reversed_at ? 'bg-gray-50 opacity-50' : 'bg-blue-50'}`}>
              <div className={`flex-1 min-w-0 ${e.reversed_at ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                <span className="font-medium">{fmt(e.amount)}</span>
                <span className="text-xs text-gray-400 ml-1.5">{e.deposit_date}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ml-1.5 ${WATER_ENTRY_CLS[e.entry_type]}`}>
                  {WATER_ENTRY_LABEL[e.entry_type]}
                </span>
                {e.memo && <span className="text-xs text-gray-400 ml-1">· {e.memo}</span>}
                {e.reversed_at && <span className="text-xs text-red-400 ml-1">(취소됨)</span>}
              </div>
              {!e.reversed_at && (
                <button onClick={() => reverseEntry(e.id)}
                  className="text-xs text-red-500 border border-red-200 px-2 py-0.5 rounded shrink-0 hover:bg-red-50">
                  취소
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <button onClick={() => setShowUsages(v => !v)} className="text-xs text-blue-500">
        {showUsages ? '▲ 사용 내역 접기' : `▼ 사용 내역 보기 (${usages.length})`}
      </button>
      {showUsages && (
        <div className="space-y-1">
          {usages.length === 0 ? <p className="text-sm text-gray-400">사용 내역 없음</p> : (
            usages.map(u => (
              <div key={u.id} className={`text-sm rounded-lg px-2 py-1.5 ${u.reversed_at ? 'bg-gray-50 opacity-50 line-through' : 'bg-teal-50'}`}>
                {u.monthly_charges?.billing_month?.slice(0, 7)} 수도세 {fmt(u.amount)} 충당
                {u.reservation_id && <span className="text-xs text-purple-600 ml-1">(퇴거 보류금)</span>}
                {u.reversed_at && <span className="text-xs text-red-400 ml-1">(취소됨)</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────
// 메인 컴포넌트
// ────────────────────────────────────────────────
export default function TenantDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [tenant, setTenant] = useState(null)
  const [charges, setCharges] = useState([])
  const [rentHistory, setRentHistory] = useState([])
  const [documents, setDocuments] = useState([])
  const [tab, setTab] = useState('charges')
  const [showRentForm, setShowRentForm] = useState(false)
  const [rentForm, setRentForm] = useState({ rent_amount: '', effective_from: format(new Date(), 'yyyy-MM-dd') })
  const [showPastUnpaidForm, setShowPastUnpaidForm] = useState(false)
  const [pastUnpaidForm, setPastUnpaidForm] = useState({ billing_month: '', amount: '' })
  const [showReplaceForm, setShowReplaceForm] = useState(false)
  const [replaceForm, setReplaceForm] = useState({
    move_out_date: '', deposit_amount: '', deducted_amount: '', memo: '',
    water_balance: 0, immediate_refund: '', reserved_amount: '', refund_account: '', refund_memo: '',
  })
  const [replacing, setReplacing] = useState(false)
  const [showContact, setShowContact] = useState(false)
  const [showNotifModal, setShowNotifModal] = useState(false)
  const fileRef = useRef()
  const [uploading, setUploading] = useState(false)
  const [docType, setDocType] = useState('')
  const [overdueMonths, setOverdueMonths] = useState([])
  const [upcomingItems, setUpcomingItems] = useState(null)

  useEffect(() => { loadAll() }, [id])

  async function loadAll() {
    const [{ data: t }, { data: ch }, { data: rh }, { data: docs }] = await Promise.all([
      supabase.from('tenants').select('*, units(unit_no)').eq('id', id).single(),
      supabase.from('monthly_charges_status').select('*').eq('tenant_id', id).order('billing_month', { ascending: false }),
      supabase.from('rent_history').select('*').eq('tenant_id', id).order('effective_from', { ascending: false }),
      supabase.from('tenant_documents').select('*, profiles(name,email)').eq('tenant_id', id).order('uploaded_at', { ascending: false }),
    ])
    setTenant(t)
    setCharges(ch || [])
    setRentHistory(rh || [])
    setDocuments(docs || [])

    // 연체 월 계산 및 charge_details fetch
    const now = new Date()
    const currentMonth = format(now, 'yyyy-MM-01')
    const todayDay = now.getDate()
    const payDay = t?.payment_day ?? null
    const allCharges = ch || []

    const overdueRows = allCharges.filter(c => {
      if (Number(c.outstanding) <= 0) return false
      if (c.billing_month < currentMonth) return true
      if (c.billing_month === currentMonth) return payDay != null && payDay < todayDay
      return false
    })
    const upcomingRow = allCharges.find(c =>
      c.billing_month === currentMonth &&
      Number(c.outstanding) > 0 &&
      !(payDay != null && payDay < todayDay)
    )

    const idsToFetch = [...overdueRows.map(r => r.id), ...(upcomingRow ? [upcomingRow.id] : [])]
    let detailsMap = {}
    if (idsToFetch.length > 0) {
      const { data: details } = await supabase
        .from('charge_details')
        .select('charge_id, expense_type_code, amount, expense_types(label)')
        .in('charge_id', idsToFetch)
      for (const d of (details || [])) {
        if (!detailsMap[d.charge_id]) detailsMap[d.charge_id] = []
        detailsMap[d.charge_id].push({
          code: d.expense_type_code,
          label: d.expense_types?.label || (d.expense_type_code === 'RENT' ? '월세' : d.expense_type_code),
          amount: Number(d.amount),
        })
      }
    }

    const oMonths = overdueRows
      .sort((a, b) => a.billing_month.localeCompare(b.billing_month))
      .map(r => ({ billing_month: r.billing_month, outstanding: Number(r.outstanding), items: detailsMap[r.id] || [] }))

    let uItems = null
    if (upcomingRow) {
      const items = detailsMap[upcomingRow.id] || []
      const nonRentItems = items.filter(i => i.code !== 'RENT')
      if (nonRentItems.length > 0) uItems = { billing_month: upcomingRow.billing_month, nonRentItems }
    }
    setOverdueMonths(oMonths)
    setUpcomingItems(uItems)
  }

  async function addRent() {
    if (!rentForm.rent_amount) { alert('금액을 입력하세요.'); return }
    await supabase.from('rent_history').insert({ tenant_id: id, rent_amount: Number(rentForm.rent_amount), effective_from: rentForm.effective_from })
    setShowRentForm(false)
    setRentForm({ rent_amount: '', effective_from: format(new Date(), 'yyyy-MM-dd') })
    await loadAll()
  }

  async function addPastUnpaid() {
    if (!pastUnpaidForm.billing_month || !pastUnpaidForm.amount) { alert('연체 월과 금액을 입력하세요.'); return }
    const billingMonth = pastUnpaidForm.billing_month + '-01'
    const amount = Number(pastUnpaidForm.amount)
    const { data: existing } = await supabase.from('monthly_charges').select('id').eq('tenant_id', id).eq('billing_month', billingMonth).maybeSingle()
    let chargeId = existing?.id
    if (!chargeId) {
      const { data: created } = await supabase.from('monthly_charges').insert({ tenant_id: id, billing_month: billingMonth }).select('id').single()
      chargeId = created?.id
    }
    if (!chargeId) { alert('청구 생성 오류'); return }
    const { data: existingDetail } = await supabase.from('charge_details').select('id').eq('charge_id', chargeId).eq('expense_type_code', 'RENT').maybeSingle()
    if (existingDetail) {
      await supabase.from('charge_details').update({ amount }).eq('id', existingDetail.id)
    } else {
      await supabase.from('charge_details').insert({ charge_id: chargeId, expense_type_code: 'RENT', amount })
    }
    setShowPastUnpaidForm(false)
    setPastUnpaidForm({ billing_month: '', amount: '' })
    await loadAll()
    alert(`${pastUnpaidForm.billing_month} 미납 ${amount.toLocaleString('ko-KR')}원 등록 완료`)
  }

  async function openReplaceForm() {
    const totalOutstanding = charges.reduce((s, c) => s + Number(c.outstanding), 0)
    const { data: bal } = await supabase
      .from('tenant_water_credit_balances').select('available_balance').eq('tenant_id', id).maybeSingle()
    const available = Number(bal?.available_balance || 0)
    setReplaceForm({
      move_out_date: format(new Date(), 'yyyy-MM-dd'),
      deposit_amount: String(tenant.deposit || ''),
      deducted_amount: String(totalOutstanding || '0'),
      memo: '',
      water_balance: available,
      immediate_refund: String(available > 0 ? available : 0),
      reserved_amount: '0',
      refund_account: '',
      refund_memo: '',
    })
    setShowReplaceForm(true)
  }

  async function saveTenantReplacement() {
    if (!replaceForm.move_out_date) { alert('퇴거일을 입력하세요.'); return }
    const immediate = Number(replaceForm.immediate_refund) || 0
    const reserved = Number(replaceForm.reserved_amount) || 0
    if (immediate + reserved !== replaceForm.water_balance) {
      alert(`즉시환급액(${immediate.toLocaleString('ko-KR')}) + 보류액(${reserved.toLocaleString('ko-KR')})이 ` +
        `현재 수도세 선납 가용잔액(${replaceForm.water_balance.toLocaleString('ko-KR')})과 일치해야 합니다.`)
      return
    }
    setReplacing(true)
    const { data: rpcResult, error } = await supabase.rpc('process_tenant_move_out', {
      p_tenant_id: id,
      p_move_out_date: replaceForm.move_out_date,
      p_deposit_amount: Number(replaceForm.deposit_amount) || 0,
      p_deducted_amount: Number(replaceForm.deducted_amount) || 0,
      p_deposit_memo: replaceForm.memo || null,
      p_immediate_refund: immediate,
      p_reserved_amount: reserved,
      p_refund_account: replaceForm.refund_account || null,
      p_refund_memo: replaceForm.refund_memo || null,
    })
    if (error) { alert('오류: ' + error.message); setReplacing(false); return }
    if (!rpcResult?.success) {
      const errMap = {
        TENANT_NOT_FOUND: '세입자를 찾을 수 없습니다.',
        ALREADY_MOVED_OUT: '이미 퇴거 처리된 세입자입니다.',
        AMOUNT_MISMATCH: `금액이 현재 잔액(${Number(rpcResult?.current_balance || 0).toLocaleString('ko-KR')}원)과 일치하지 않습니다.`,
      }
      alert('⚠ ' + (errMap[rpcResult?.error] || rpcResult?.error || '알 수 없는 오류'))
      setReplacing(false)
      return
    }
    setReplacing(false)
    navigate(`/tenants/new?unit_id=${tenant.unit_id}`, { replace: true })
  }

  async function uploadDocument(e) {
    const file = e.target.files[0]
    if (!file) return
    setUploading(true)
    const path = `${id}/${Date.now()}_${file.name}`
    const { error: uploadErr } = await supabase.storage.from('tenant-documents').upload(path, file)
    if (uploadErr) { alert('업로드 오류: ' + uploadErr.message); setUploading(false); return }
    await supabase.from('tenant_documents').insert({ tenant_id: id, file_path: path, file_name: file.name, doc_type: docType || null, uploaded_by: user.id })
    setDocType('')
    setUploading(false)
    await loadAll()
  }

  async function downloadDocument(doc) {
    const { data } = await supabase.storage.from('tenant-documents').createSignedUrl(doc.file_path, 60)
    if (data?.signedUrl) window.open(data.signedUrl)
  }

  if (!tenant) return <div className="text-center py-8 text-gray-400">불러오는 중...</div>

  const latestCharge = charges[0] || null
  const hasOverdue = overdueMonths.length > 0

  const TABS = [
    { key: 'contract', label: '계약' },
    { key: 'charges',  label: '청구·입금' },
    { key: 'docs',     label: '문서' },
    { key: 'overdue',  label: hasOverdue ? `연체 ${overdueMonths.length}` : '연체', disabled: !hasOverdue },
  ]

  return (
    <div className="space-y-4">
      {showContact && (
        <ContactSheet tenant={tenant} latestCharge={latestCharge} onClose={() => setShowContact(false)} />
      )}
      {showNotifModal && (
        <NotificationModal
          tenant={tenant}
          overdueMonths={overdueMonths.length > 0 ? overdueMonths : undefined}
          onClose={() => setShowNotifModal(false)}
        />
      )}

      {/* 헤더 */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-2xl px-1">←</button>
        <div className="flex-1">
          <button onClick={() => setShowContact(true)} className="text-xl font-bold text-gray-800 text-left hover:text-blue-600">
            {tenant.units?.unit_no} {tenant.name} <span className="text-base text-gray-400">📞</span>
          </button>
          <p className="text-sm text-gray-500">{tenant.residents}명 · 보증금 {fmt(tenant.deposit)}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasOverdue && (
            <span className="text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">연체</span>
          )}
          {!tenant.is_owner && (
            <button
              onClick={() => setShowNotifModal(true)}
              className="text-xs bg-yellow-400 text-gray-900 font-medium px-2.5 py-1 rounded-full"
            >
              알림톡
            </button>
          )}
        </div>
      </div>

      {/* 탭 바 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
        {TABS.map(({ key, label, disabled }) =>
          disabled ? (
            <span key={key} className="flex-1 py-2 rounded-lg text-sm font-medium text-center text-gray-300 cursor-not-allowed select-none">
              {label}
            </span>
          ) : (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === key
                  ? key === 'overdue' ? 'bg-red-500 shadow text-white' : 'bg-white shadow text-gray-800'
                  : 'text-gray-500'
              }`}
            >
              {label}
            </button>
          )
        )}
      </div>

      {/* ── 계약 탭 ── */}
      {tab === 'contract' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl shadow-sm p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-700">계약 정보</h3>
              <div className="flex gap-2">
                <button
                  onClick={openReplaceForm}
                  className="text-sm border border-orange-300 text-orange-600 px-3 py-1.5 rounded-lg hover:bg-orange-50"
                >
                  세입자 교체
                </button>
                <button onClick={() => navigate(`/tenants/${id}/edit`)}
                  className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-50">
                  수정
                </button>
              </div>
            </div>
            <dl className="space-y-2.5">
              {[
                ['입주일',   tenant.move_in_date || '-'],
                ['계약만료', tenant.contract_end
                  ? `${tenant.contract_end}${tenant.auto_renew ? '  (자동갱신)' : ''}`
                  : '-'],
                ['보증금',   fmt(tenant.deposit)],
                ['입금일',   tenant.payment_day ? `매월 ${tenant.payment_day}일` : '-'],
                ['거주인원', tenant.residents ? `${tenant.residents}명` : '-'],
                ['연락처',   tenant.phone || '-'],
                ['메모',     tenant.memo || '-'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start gap-3">
                  <dt className="text-xs text-gray-400 w-16 shrink-0 pt-0.5">{label}</dt>
                  <dd className="text-sm text-gray-800 font-medium flex-1">{value}
                    {label === '계약만료' && <ContractBadge tenant={tenant} />}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* 세입자 교체 폼 */}
          {showReplaceForm && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-orange-800">세입자 교체</h3>
                <button onClick={() => setShowReplaceForm(false)} className="text-orange-400 text-lg">✕</button>
              </div>
              <p className="text-xs text-orange-600">
                퇴거 처리 후 이 호실에 새 세입자 등록 화면으로 이동합니다.
              </p>
              <div>
                <label className="text-xs text-gray-600 block mb-0.5">퇴거일</label>
                <input
                  type="date"
                  value={replaceForm.move_out_date}
                  onChange={e => setReplaceForm(f => ({ ...f, move_out_date: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-gray-600 block mb-0.5">보증금 (원)</label>
                  <input
                    type="number"
                    value={replaceForm.deposit_amount}
                    onChange={e => setReplaceForm(f => ({ ...f, deposit_amount: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-0.5">차감액 (원)</label>
                  <input
                    type="number"
                    value={replaceForm.deducted_amount}
                    onChange={e => setReplaceForm(f => ({ ...f, deducted_amount: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>
              {/* 실반환액 미리보기 */}
              {replaceForm.deposit_amount !== '' && (
                <div className="bg-white rounded-lg px-3 py-2 text-sm border border-orange-100">
                  <span className="text-gray-500">실 반환액: </span>
                  <span className="font-bold text-gray-800">
                    ₩{Math.max(0, (Number(replaceForm.deposit_amount) || 0) - (Number(replaceForm.deducted_amount) || 0)).toLocaleString('ko-KR')}
                  </span>
                </div>
              )}
              <div>
                <label className="text-xs text-gray-600 block mb-0.5">차감 사유 메모</label>
                <input
                  type="text"
                  value={replaceForm.memo}
                  onChange={e => setReplaceForm(f => ({ ...f, memo: e.target.value }))}
                  placeholder="예: 미납 임대료, 원상복구 비용"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
              </div>

              {/* 수도세 선납 잔액 즉시환급 / 보류 분리 */}
              {replaceForm.water_balance > 0 && (
                <div className="space-y-2 pt-2 border-t border-orange-200">
                  <p className="text-xs font-semibold text-orange-700">
                    💧 수도세 선납 가용잔액 {fmt(replaceForm.water_balance)} — 즉시환급/보류로 나누세요
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-gray-600 block mb-0.5">즉시 환급액</label>
                      <input
                        type="number"
                        value={replaceForm.immediate_refund}
                        onChange={e => setReplaceForm(f => ({ ...f, immediate_refund: e.target.value }))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-600 block mb-0.5">수도세 정산 보류액</label>
                      <input
                        type="number"
                        value={replaceForm.reserved_amount}
                        onChange={e => setReplaceForm(f => ({ ...f, reserved_amount: e.target.value }))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  {(Number(replaceForm.immediate_refund) || 0) + (Number(replaceForm.reserved_amount) || 0) !== replaceForm.water_balance && (
                    <p className="text-xs text-red-500">
                      즉시환급 + 보류액의 합이 가용잔액({fmt(replaceForm.water_balance)})과 일치해야 합니다.
                    </p>
                  )}
                  {Number(replaceForm.reserved_amount) > 0 && (
                    <>
                      <p className="text-xs text-orange-600">
                        보류액은 실제 수도 고지서가 나와 겹치는 거주기간만큼 정산된 뒤 자동으로 환급되거나 미수금으로 남습니다.
                      </p>
                      <input
                        type="text"
                        value={replaceForm.refund_account}
                        onChange={e => setReplaceForm(f => ({ ...f, refund_account: e.target.value }))}
                        placeholder="최종 환급 계좌"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                      <input
                        type="text"
                        value={replaceForm.refund_memo}
                        onChange={e => setReplaceForm(f => ({ ...f, refund_memo: e.target.value }))}
                        placeholder="환급 관련 메모(선택)"
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      />
                    </>
                  )}
                </div>
              )}

              <button
                onClick={saveTenantReplacement}
                disabled={replacing}
                className="w-full bg-orange-500 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {replacing ? '처리 중...' : '퇴거 처리 후 새 세입자 등록 →'}
              </button>
            </div>
          )}

          {/* 월세 이력 카드 */}
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-700 text-sm">월세 이력</h3>
              <button
                onClick={() => setShowRentForm(v => !v)}
                className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg"
              >
                {showRentForm ? '닫기' : '+ 월세 변경'}
              </button>
            </div>

            {showRentForm && (
              <div className="space-y-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <div>
                  <label className="text-xs text-gray-500 block mb-0.5">새 월세 금액</label>
                  <input type="number" value={rentForm.rent_amount}
                    onChange={e => setRentForm(f => ({ ...f, rent_amount: e.target.value }))}
                    placeholder="금액 입력" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-0.5">적용 시작일</label>
                  <input type="date" value={rentForm.effective_from}
                    onChange={e => setRentForm(f => ({ ...f, effective_from: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
                </div>
                <button onClick={addRent} className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium">저장</button>
              </div>
            )}

            {rentHistory.length === 0 ? (
              <p className="text-sm text-gray-400">월세 이력 없음 — 수정 페이지에서 등록하거나 위 버튼으로 추가하세요.</p>
            ) : (
              <ul className="space-y-1.5">
                {rentHistory.map((r, i) => {
                  const isLatest = i === 0
                  const nextEntry = isLatest ? null : rentHistory[i - 1]
                  return (
                    <li key={r.id} className={`flex items-baseline justify-between text-sm ${isLatest ? '' : 'text-gray-400'}`}>
                      <span className={isLatest ? 'font-bold text-gray-800 text-base' : ''}>
                        {fmt(r.rent_amount)}
                      </span>
                      <span className={`text-xs ${isLatest ? 'text-gray-500' : 'text-gray-400'}`}>
                        {r.effective_from}
                        {isLatest ? ' 부터 (현재)' : nextEntry ? ` ~ ${nextEntry.effective_from}` : ''}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── 청구·입금 탭 ── */}
      {tab === 'charges' && (
        <div className="space-y-3">
          {!tenant.is_owner && <WaterCreditCard tenantId={id} userId={user?.id} />}
          {charges.length === 0 ? (
            <div className="text-center py-8 text-gray-400">청구 내역이 없습니다.</div>
          ) : (
            charges.map(c => (
              <ChargeCard
                key={c.id}
                charge={c}
                onPaymentAdded={loadAll}
                userId={user?.id}
                paymentDay={tenant?.payment_day}
              />
            ))
          )}

          {/* 보조 기능 — 탭 하단에 작게 */}
          <div className="pt-2">
            <button
              onClick={() => setShowPastUnpaidForm(v => !v)}
              className="w-full text-xs py-2 rounded-lg border border-red-200 text-red-500 hover:bg-red-50"
            >
              {showPastUnpaidForm ? '과거 미납 닫기' : '과거 미납 추가'}
            </button>
          </div>

          {/* 과거 미납 추가 인라인 패널 */}
          {showPastUnpaidForm && (
            <div className="bg-white rounded-xl shadow-sm p-4 space-y-2">
              <p className="text-sm font-semibold text-red-700">과거 미납 등록</p>
              <p className="text-xs text-red-500">시스템에 기록 없는 과거 연체를 수동으로 추가합니다.</p>
              <div>
                <label className="text-xs text-gray-500 block mb-0.5">연체 월</label>
                <input type="month" value={pastUnpaidForm.billing_month} onChange={e => setPastUnpaidForm(f => ({ ...f, billing_month: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-0.5">청구 금액 (원)</label>
                <input type="number" value={pastUnpaidForm.amount} onChange={e => setPastUnpaidForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder={rentHistory[0]?.rent_amount || '예: 500000'}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
              </div>
              <button onClick={addPastUnpaid} className="w-full bg-red-600 text-white py-2 rounded-lg text-sm font-medium">
                미납으로 등록
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 문서 탭 ── */}
      {tab === 'docs' && (
        <div className="space-y-3">
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
            <h3 className="font-semibold text-gray-700">문서 업로드</h3>
            <input type="text" value={docType} onChange={e => setDocType(e.target.value)}
              placeholder="문서 종류 (예: 계약서, 신분증, 계좌번호)"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input ref={fileRef} type="file" className="hidden" onChange={uploadDocument} />
            <button onClick={() => fileRef.current.click()} disabled={uploading}
              className="w-full border-2 border-dashed border-gray-300 text-gray-500 py-3 rounded-lg text-sm disabled:opacity-50">
              {uploading ? '업로드 중...' : '파일 선택'}
            </button>
          </div>
          {documents.length === 0 ? (
            <div className="text-center py-6 text-gray-400">업로드된 문서가 없습니다.</div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <ul className="divide-y divide-gray-50">
                {documents.map(d => (
                  <li key={d.id} className="px-4 py-3 flex items-center gap-3">
                    <div className="flex-1">
                      <div className="font-medium text-sm text-gray-800">{d.file_name}</div>
                      <div className="text-xs text-gray-500">
                        {d.doc_type && `${d.doc_type} · `}
                        {d.uploaded_at?.slice(0, 10)} · {d.profiles?.name || d.profiles?.email}
                      </div>
                    </div>
                    <button onClick={() => downloadDocument(d)} className="text-xs text-blue-600 border border-blue-200 px-2 py-1 rounded-lg">
                      다운로드
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── 연체 탭 ── */}
      {tab === 'overdue' && (
        <div>
          {hasOverdue ? (
            <OverdueSection tenant={tenant} overdueMonths={overdueMonths} upcomingItems={upcomingItems} />
          ) : (
            <div className="text-center py-16 text-gray-400">연체 내역이 없습니다.</div>
          )}
        </div>
      )}
    </div>
  )
}

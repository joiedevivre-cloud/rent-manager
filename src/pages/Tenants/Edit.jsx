// =============================================================
// 세입자 정보 수정 — /tenants/:id/edit
// =============================================================
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

function fmt(n) {
  return '₩' + Number(n).toLocaleString('ko-KR')
}

export default function TenantEdit() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [rentHistory, setRentHistory] = useState([])
  const [rentAmount, setRentAmount] = useState('')
  const [rentEffectiveFrom, setRentEffectiveFrom] = useState('')

  useEffect(() => {
    Promise.all([
      supabase.from('tenants').select('*').eq('id', id).single(),
      supabase.from('rent_history').select('*').eq('tenant_id', id).order('effective_from', { ascending: false }),
    ]).then(([{ data: t }, { data: rh }]) => {
      if (t) setForm({ ...t })
      const history = rh || []
      setRentHistory(history)
      if (history.length > 0) setRentAmount(String(history[0].rent_amount))
    })
  }, [id])

  const currentRent = rentHistory.length > 0 ? Number(rentHistory[0].rent_amount) : null
  const rentChanged = rentAmount !== '' && Number(rentAmount) !== currentRent

  async function save() {
    if (!form.name?.trim()) { alert('이름을 입력해주세요.'); return }
    if (form.move_in_date && form.contract_end && form.contract_end <= form.move_in_date) {
      alert('계약만료일은 입주일보다 이후여야 합니다.'); return
    }
    if (form.payment_day) {
      const day = Number(form.payment_day)
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        alert('입금일은 1~31 사이 숫자여야 합니다.'); return
      }
    }

    if (rentAmount !== '' && Number(rentAmount) > 0) {
      if (rentHistory.length === 0) {
        // 첫 등록 — effective_from = 입주일
        const effectiveFrom = form.move_in_date || new Date().toISOString().slice(0, 10)
        const { error } = await supabase.from('rent_history').insert({
          tenant_id: id,
          rent_amount: Number(rentAmount),
          effective_from: effectiveFrom,
        })
        if (error) { alert('월세 등록 오류: ' + error.message); return }
      } else if (rentChanged) {
        if (!rentEffectiveFrom) { alert('적용 시작일을 입력해주세요.'); return }
        const { error } = await supabase.from('rent_history').insert({
          tenant_id: id,
          rent_amount: Number(rentAmount),
          effective_from: rentEffectiveFrom,
        })
        if (error) { alert('월세 변경 오류: ' + error.message); return }
      }
    }

    setSaving(true)
    await supabase.from('tenants').update({
      name: form.name,
      phone: form.phone || null,
      residents: form.residents ? Number(form.residents) : null,
      move_in_date: form.move_in_date || null,
      move_out_date: form.move_out_date || null,
      contract_end: form.contract_end || null,
      auto_renew: !!form.auto_renew,
      deposit: form.deposit ? Number(form.deposit) : null,
      payment_day: form.payment_day ? Number(form.payment_day) : null,
      memo: form.memo || null,
    }).eq('id', id)
    setSaving(false)
    navigate(`/tenants/${id}`, { replace: true })
  }

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }))
  }

  if (!form) return <div className="text-center py-8 text-gray-400">불러오는 중...</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-2xl px-1">←</button>
        <h2 className="text-lg font-bold text-gray-800">세입자 정보 수정</h2>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
        {[
          ['이름',        'name',         'text'],
          ['전화번호',     'phone',         'text'],
          ['거주인원',     'residents',     'number'],
          ['입주일',      'move_in_date',  'date'],
          ['계약만료일',   'contract_end',  'date'],
          ['퇴거일',      'move_out_date', 'date'],
          ['보증금',      'deposit',       'number'],
          ['입금일(매월)', 'payment_day',   'number'],
          ['메모',        'memo',          'text'],
        ].map(([label, key, type]) => (
          <div key={key}>
            <label className="text-xs text-gray-500 block mb-0.5">{label}</label>
            <input
              type={type}
              value={form[key] ?? ''}
              onChange={e => set(key, e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        ))}

        {/* 월세 */}
        <div>
          <label className="text-xs text-gray-500 block mb-0.5">
            월세
            {currentRent != null && (
              <span className="text-gray-400 ml-1.5">(현재 {fmt(currentRent)})</span>
            )}
          </label>
          <input
            type="number"
            value={rentAmount}
            onChange={e => setRentAmount(e.target.value)}
            placeholder={rentHistory.length === 0 ? '첫 등록 — 입주일 기준 적용' : '변경 시 이력에 추가됩니다'}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>

        {/* 월세 변경 시 적용 시작일 */}
        {rentChanged && (
          <div>
            <label className="text-xs text-amber-600 block mb-0.5">
              ⚠ 월세 변경 — 적용 시작일
            </label>
            <input
              type="date"
              value={rentEffectiveFrom}
              onChange={e => setRentEffectiveFrom(e.target.value)}
              className="w-full border border-amber-200 rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">이 날짜 이후 청구서부터 새 금액이 적용됩니다.</p>
          </div>
        )}

        <p className="text-xs text-gray-400">* 월세 변경 이력은 세입자 상세 &gt; 계약 탭에서 확인할 수 있습니다.</p>

        {/* 자동갱신 토글 */}
        <div className="flex items-center justify-between border border-gray-200 rounded-lg px-3 py-2.5 bg-gray-50">
          <div>
            <p className="text-sm text-gray-700 font-medium">자동갱신 (묵시적 갱신)</p>
            <p className="text-xs text-gray-400">계약 종료 후 동일 기간으로 자동 연장</p>
          </div>
          <button
            type="button"
            onClick={() => set('auto_renew', !form.auto_renew)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.auto_renew ? 'bg-blue-600' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.auto_renew ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? '저장 중...' : '저장'}
        </button>
      </div>
    </div>
  )
}

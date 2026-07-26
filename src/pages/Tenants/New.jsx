import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { format } from 'date-fns'

export default function TenantNew() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const unitId = searchParams.get('unit_id')

  const [unit, setUnit] = useState(null)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    residents: '',
    move_in_date: format(new Date(), 'yyyy-MM-dd'),
    contract_end: '',
    deposit: '',
    payment_day: '',
    memo: '',
    auto_renew: false,
  })
  const [rentAmount, setRentAmount] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (unitId) {
      supabase.from('units').select('id, unit_no').eq('id', unitId).single()
        .then(({ data }) => setUnit(data))
    }
  }, [unitId])

  function set(key, val) {
    setForm(f => ({ ...f, [key]: val }))
  }

  async function save() {
    if (!form.name?.trim()) { alert('이름을 입력해주세요.'); return }
    if (!unitId) { alert('호실 정보가 없습니다.'); return }
    if (form.move_in_date && form.contract_end && form.contract_end <= form.move_in_date) {
      alert('계약만료일은 입주일보다 이후여야 합니다.'); return
    }
    if (form.payment_day) {
      const day = Number(form.payment_day)
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        alert('입금일은 1~31 사이 숫자여야 합니다.'); return
      }
    }

    setSaving(true)
    const { data: tenant, error } = await supabase.from('tenants').insert({
      unit_id: unitId,
      name: form.name.trim(),
      phone: form.phone || null,
      residents: form.residents ? Number(form.residents) : null,
      move_in_date: form.move_in_date || null,
      contract_end: form.contract_end || null,
      deposit: form.deposit ? Number(form.deposit) : null,
      payment_day: form.payment_day ? Number(form.payment_day) : null,
      memo: form.memo || null,
      auto_renew: !!form.auto_renew,
    }).select('id').single()

    if (error) { alert('저장 오류: ' + error.message); setSaving(false); return }

    if (rentAmount && Number(rentAmount) > 0) {
      await supabase.from('rent_history').insert({
        tenant_id: tenant.id,
        rent_amount: Number(rentAmount),
        effective_from: form.move_in_date || format(new Date(), 'yyyy-MM-dd'),
      })
    }

    setSaving(false)
    navigate(`/tenants/${tenant.id}`, { replace: true })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="text-gray-500 text-2xl px-1">←</button>
        <div>
          <h2 className="text-lg font-bold text-gray-800">새 세입자 등록</h2>
          {unit && <p className="text-sm text-blue-600 font-medium">{unit.unit_no}</p>}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
        {[
          ['이름',        'name',         'text'],
          ['전화번호',     'phone',        'text'],
          ['거주인원',     'residents',    'number'],
          ['입주일',      'move_in_date', 'date'],
          ['계약만료일',   'contract_end', 'date'],
          ['보증금',      'deposit',      'number'],
          ['입금일(매월)', 'payment_day',  'number'],
          ['메모',        'memo',         'text'],
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

        <div>
          <label className="text-xs text-gray-500 block mb-0.5">월세</label>
          <input
            type="number"
            value={rentAmount}
            onChange={e => setRentAmount(e.target.value)}
            placeholder="입주일 기준 적용"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>

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
          {saving ? '저장 중...' : '세입자 등록'}
        </button>
      </div>
    </div>
  )
}

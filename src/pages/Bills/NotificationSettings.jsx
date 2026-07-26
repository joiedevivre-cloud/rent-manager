import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { supabase } from '../../lib/supabase'

export default function NotificationSettings() {
  const [settings, setSettings] = useState(null)
  const [tenants, setTenants] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [])

  async function load() {
    const todayStr = format(new Date(), 'yyyy-MM-dd')
    const [{ data: s }, { data: t }] = await Promise.all([
      supabase.from('notification_settings').select('*').limit(1).maybeSingle(),
      supabase.from('tenants')
        .select('id, name, notification_enabled, is_owner, units(unit_no)')
        .or(`move_out_date.is.null,move_out_date.gte.${todayStr}`)
        .order('created_at'),
    ])
    setSettings(s || { remind_days_before: 3, overdue_days_after: 1, sender_phone: '', bank_account: '', owner_name: '' })
    setTenants(t || [])
    setLoading(false)
  }

  async function saveSettings() {
    setSaving(true)
    const { data: existing } = await supabase.from('notification_settings').select('id').limit(1).maybeSingle()
    if (existing?.id) {
      await supabase.from('notification_settings')
        .update({ ...settings, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await supabase.from('notification_settings').insert(settings)
    }
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function toggleTenant(tenantId, enabled) {
    await supabase.from('tenants').update({ notification_enabled: enabled }).eq('id', tenantId)
    setTenants(prev => prev.map(t => t.id === tenantId ? { ...t, notification_enabled: enabled } : t))
  }

  if (loading) return <div className="text-center py-8 text-gray-400">불러오는 중...</div>

  return (
    <div className="space-y-4">
      {/* 자동 발송 설정 */}
      <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
        <h3 className="font-semibold text-gray-700 text-sm">자동 발송 설정</h3>
        <p className="text-xs text-gray-400">매일 오전 9시(KST)에 자동 발송 · 토/일/공휴일 제외</p>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-gray-600 shrink-0">납부 안내 — 입금일</span>
          <input
            type="number" min="0" max="14"
            value={settings.remind_days_before ?? 3}
            onChange={e => setSettings(s => ({ ...s, remind_days_before: Number(e.target.value) }))}
            className="w-14 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center"
          />
          <span className="text-sm text-gray-600">일 전 발송</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-gray-600 shrink-0">연체 안내 — 납부 기한 경과 후</span>
          <input
            type="number" min="1" max="30"
            value={settings.overdue_days_after ?? 1}
            onChange={e => setSettings(s => ({ ...s, overdue_days_after: Number(e.target.value) }))}
            className="w-14 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center"
          />
          <span className="text-sm text-gray-600">일째 발송 (최대 3회: +1·+7·+14일)</span>
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">납부 계좌번호</label>
          <input
            type="text"
            value={settings.bank_account || ''}
            onChange={e => setSettings(s => ({ ...s, bank_account: e.target.value }))}
            placeholder="예: 국민은행 123-456-789012 홍길동"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">집주인 이름 (알림톡 서명)</label>
          <input
            type="text"
            value={settings.owner_name || ''}
            onChange={e => setSettings(s => ({ ...s, owner_name: e.target.value }))}
            placeholder="예: 황인자"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">발신번호 (알리고 등록 번호)</label>
          <input
            type="text"
            value={settings.sender_phone || ''}
            onChange={e => setSettings(s => ({ ...s, sender_phone: e.target.value }))}
            placeholder="예: 010-1234-5678"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>

        <button
          onClick={saveSettings}
          disabled={saving}
          className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
            saved ? 'bg-green-600 text-white' : 'bg-gray-800 text-white'
          }`}
        >
          {saved ? '✓ 저장됨' : saving ? '저장 중...' : '설정 저장'}
        </button>
      </div>

      {/* 세입자별 알림 ON/OFF */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-700 text-sm">세입자별 알림</h3>
          <p className="text-xs text-gray-400 mt-0.5">집주인 거주 세입자는 자동 제외됩니다</p>
        </div>
        <ul className="divide-y divide-gray-50">
          {tenants.map(t => (
            <li key={t.id} className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-500 w-12 shrink-0">{t.units?.unit_no}</span>
                <span className="text-sm text-gray-800">{t.name}</span>
                {t.is_owner && (
                  <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">집주인</span>
                )}
              </div>
              {t.is_owner ? (
                <span className="text-xs text-gray-400">발송 제외</span>
              ) : (
                <button
                  type="button"
                  onClick={() => toggleTenant(t.id, !(t.notification_enabled !== false))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    t.notification_enabled !== false ? 'bg-blue-600' : 'bg-gray-300'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    t.notification_enabled !== false ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* API 설정 안내 */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-1.5">
        <p className="text-xs font-semibold text-gray-600">알리고 연동 순서</p>
        {[
          '1. 사업자 등록 완료',
          '2. aligo.in 가입 → 알림톡 서비스 신청',
          '3. 카카오채널 개설 → 알리고에 연동',
          '4. 템플릿 2종 등록 (납부 안내 / 연체 안내)',
          '5. data.go.kr에서 공휴일 API 키 발급',
          '6. Supabase Dashboard → Edge Functions → Manage secrets에 등록',
          '   ALIGO_API_KEY / ALIGO_USER_ID / ALIGO_SENDER',
          '   KAKAO_CHANNEL_ID / ALIGO_TPL_PAYMENT_REMIND / ALIGO_TPL_OVERDUE',
          '   HOLIDAY_API_KEY',
        ].map(s => <p key={s} className="text-xs text-gray-500 font-mono">{s}</p>)}
      </div>
    </div>
  )
}

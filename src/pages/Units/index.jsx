import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { format, differenceInDays, parseISO } from 'date-fns'

export default function Units() {
  const [units, setUnits] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState(null)
  const [memo, setMemo] = useState('')
  const navigate = useNavigate()
  const today = new Date()
  const todayStr = format(today, 'yyyy-MM-dd')

  useEffect(() => {
    supabase.from('units')
      .select('*, tenants(id, name, move_out_date, move_in_date)')
      .order('unit_no')
      .then(({ data }) => { setUnits(data || []); setLoading(false) })
  }, [])

  async function saveMemo(id) {
    await supabase.from('units').update({ memo }).eq('id', id)
    setUnits(u => u.map(x => x.id === id ? { ...x, memo } : x))
    setEditingId(null)
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-gray-800">🏠 호실 관리</h2>
      {loading ? (
        <div className="text-center py-8 text-gray-400">불러오는 중...</div>
      ) : (
        <div className="space-y-2">
          {units.map(u => {
            // 현재 거주 중인 세입자 (move_out_date = null 또는 미래)
            const activeTenant = u.tenants?.find(t => !t.move_out_date || t.move_out_date >= todayStr)
            const isVacant = !activeTenant
            const moveOutDate = activeTenant?.move_out_date || null
            const daysUntilMoveOut = moveOutDate ? differenceInDays(parseISO(moveOutDate), today) : null

            return (
              <div
                key={u.id}
                className={`rounded-xl shadow-sm p-4 ${
                  isVacant ? 'bg-gray-50 border-2 border-dashed border-gray-200' : 'bg-white'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-bold text-lg ${isVacant ? 'text-gray-400' : 'text-gray-800'}`}>
                      {u.unit_no}
                    </span>
                    {isVacant ? (
                      <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded font-medium">공실</span>
                    ) : daysUntilMoveOut != null && daysUntilMoveOut <= 30 ? (
                      <span className="text-xs text-orange-700 bg-orange-100 px-2 py-0.5 rounded font-medium">
                        퇴거 임박 D-{daysUntilMoveOut}
                      </span>
                    ) : daysUntilMoveOut != null ? (
                      <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                        퇴거 예정 {moveOutDate}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2">
                    {!isVacant && editingId !== u.id && (
                      <button
                        onClick={() => { setEditingId(u.id); setMemo(u.memo || '') }}
                        className="text-xs text-gray-500 border border-gray-200 px-2 py-1 rounded-lg"
                      >
                        메모 수정
                      </button>
                    )}
                    {isVacant && (
                      <button
                        onClick={() => navigate(`/tenants/new?unit_id=${u.id}`)}
                        className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg font-medium"
                      >
                        새 세입자 등록
                      </button>
                    )}
                  </div>
                </div>

                <div className={`text-sm mt-1 ${isVacant ? 'text-gray-400' : 'text-gray-500'}`}>
                  {isVacant
                    ? '현재 공실'
                    : `현재: ${activeTenant.name}${activeTenant.move_in_date ? ` · 입주 ${activeTenant.move_in_date}` : ''}`}
                </div>

                {editingId === u.id ? (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={memo}
                      onChange={e => setMemo(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      rows={2}
                      placeholder="메모"
                    />
                    <div className="flex gap-2">
                      <button onClick={() => saveMemo(u.id)} className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm">저장</button>
                      <button onClick={() => setEditingId(null)} className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm">취소</button>
                    </div>
                  </div>
                ) : u.memo && !isVacant && (
                  <p className="mt-2 text-sm text-gray-500">{u.memo}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

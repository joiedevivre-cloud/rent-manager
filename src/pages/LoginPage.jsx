import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

function KakaoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3C6.477 3 2 6.477 2 10.8c0 2.717 1.7 5.104 4.274 6.498L5.2 21l4.63-2.44A11.2 11.2 0 0 0 12 18.6c5.523 0 10-3.477 10-7.8C22 6.477 17.523 3 12 3z"
        fill="#000000"
      />
    </svg>
  )
}

export default function LoginPage() {
  const { signInWithGoogle, signInWithKakao, accessDenied } = useAuth()
  const [kakaoError, setKakaoError] = useState(false)

  async function handleKakao() {
    setKakaoError(false)
    try {
      await signInWithKakao()
    } catch {
      setKakaoError(true)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white rounded-2xl shadow-md p-8 w-full max-w-sm text-center">
        <div className="text-5xl mb-4">🏠</div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">임대 관리</h1>
        <p className="text-gray-500 text-sm mb-8">가족 전용 임대 관리 앱</p>

        {accessDenied && (
          <div className="mb-5 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
            권한이 없는 계정입니다.<br />
            등록된 가족 계정으로 로그인해 주세요.
          </div>
        )}

        {kakaoError && (
          <div className="mb-5 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg px-4 py-3 text-sm">
            카카오 로그인 설정 준비 중입니다.
          </div>
        )}

        {/* Google 로그인 */}
        <button
          onClick={signInWithGoogle}
          className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 rounded-xl py-3 px-4 text-gray-700 font-medium shadow-sm hover:bg-gray-50 active:bg-gray-100 transition-colors text-base"
        >
          <svg width="20" height="20" viewBox="0 0 48 48">
            <path fill="#FFC107" d="M43.6 20H24v8h11.3C33.6 32.5 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34 6.5 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-4z"/>
            <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.5 15.8 18.9 12 24 12c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34 6.5 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-1.9 13.4-5l-6.2-5.2C29.5 35.6 26.9 36 24 36c-5.3 0-9.6-3.5-11.3-8.2l-6.5 5C9.5 39.4 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20H24v8h11.3c-.9 2.6-2.6 4.8-4.8 6.4l6.2 5.2C40.9 36.2 44 30.5 44 24c0-1.3-.1-2.7-.4-4z"/>
          </svg>
          Google로 로그인
        </button>

        {/* 구분선 */}
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-xs text-gray-400">또는</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        {/* 카카오 로그인 */}
        <button
          onClick={handleKakao}
          className="w-full flex items-center justify-center gap-3 rounded-xl py-3 px-4 font-medium shadow-sm transition-colors text-base"
          style={{ backgroundColor: '#FEE500', color: '#000000' }}
        >
          <KakaoIcon />
          카카오로 로그인
        </button>
      </div>
    </div>
  )
}

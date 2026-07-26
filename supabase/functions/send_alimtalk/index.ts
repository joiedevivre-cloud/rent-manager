// Supabase Edge Function: send_alimtalk
// 클라이언트(NotificationModal)에서 수동 발송 시 호출
// Aligo API 자격증명은 서버사이드 secrets에만 보관

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

// fallback 없이 읽기 — 미설정 시 undefined, 아래 validateSecrets()에서 명시적 실패
const ALIGO_API_KEY     = Deno.env.get('ALIGO_API_KEY')
const ALIGO_USER_ID     = Deno.env.get('ALIGO_USER_ID')
const ALIGO_SENDER      = Deno.env.get('ALIGO_SENDER')
const KAKAO_CHANNEL_ID  = Deno.env.get('KAKAO_CHANNEL_ID')
const ALIGO_TPL_PAYMENT = Deno.env.get('ALIGO_TPL_PAYMENT_REMIND')
const ALIGO_TPL_OVERDUE = Deno.env.get('ALIGO_TPL_OVERDUE')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// 필수 시크릿 누락 여부 반환 (빈 문자열도 누락으로 취급)
function missingSecrets(): string[] {
  const required: Record<string, string | undefined> = {
    ALIGO_API_KEY, ALIGO_USER_ID, ALIGO_SENDER, KAKAO_CHANNEL_ID,
    ALIGO_TPL_PAYMENT_REMIND: ALIGO_TPL_PAYMENT,
    ALIGO_TPL_OVERDUE,
  }
  return Object.entries(required)
    .filter(([, v]) => !v || v.trim() === '')
    .map(([k]) => k)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    const { phone, message, notification_type } = await req.json()

    if (!phone || !message || !notification_type) {
      return json({ success: false, error: 'MISSING_PARAMS' }, 400)
    }

    // API 키 미설정 — 클라이언트에서 PENDING으로 처리하도록 알림
    const missing = missingSecrets()
    if (missing.length > 0) {
      console.warn('[send_alimtalk] 시크릿 미설정:', missing.join(', '))
      return json({ success: false, error: 'NO_API_KEY', missing })
    }

    const tplCode = notification_type === 'PAYMENT_REMIND' ? ALIGO_TPL_PAYMENT! : ALIGO_TPL_OVERDUE!
    const subject = notification_type === 'PAYMENT_REMIND' ? '임대료 납부 안내' : '임대료 연체 안내'

    const form = new FormData()
    form.append('apikey', ALIGO_API_KEY!)
    form.append('userid', ALIGO_USER_ID!)
    form.append('senderkey', KAKAO_CHANNEL_ID!)
    form.append('tpl_code', tplCode)
    form.append('sender', ALIGO_SENDER!)
    form.append('receiver_1', phone.replace(/[^0-9]/g, ''))
    form.append('subject_1', subject)
    form.append('message_1', message)

    const res = await fetch('https://kakaoapi.aligo.in/akv10/alimtalk/send/', {
      method: 'POST',
      body: form,
    })
    const data = await res.json()

    if (data.code !== 0) {
      return json({ success: false, error: data.message || '알리고 오류' })
    }

    return json({ success: true, mid: data?.mid?.toString() ?? '' })
  } catch (e: any) {
    return json({ success: false, error: e.message }, 500)
  }
})

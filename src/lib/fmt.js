export function fmt(n) {
  if (n == null) return '-'
  return '₩' + Number(n).toLocaleString('ko-KR')
}

export function fmtNum(n) {
  if (n == null) return '-'
  return Number(n).toLocaleString('ko-KR')
}

export function fmtK(n) {
  if (!n) return '₩0'
  const k = Math.round(Number(n) / 1000)
  return '₩' + k.toLocaleString('ko-KR') + 'K'
}

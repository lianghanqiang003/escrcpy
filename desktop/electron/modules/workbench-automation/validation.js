export const SCRIPT_IDS = ['jd-cart', 'jd-coupon', 'jd-check', 'vip-coupon']
export const ACTIVE_PHASES = ['queued', 'running', 'waiting', 'paused', 'stopping']

export function validateRequest(input) {
  if (!SCRIPT_IDS.includes(input?.scriptId))
    throw new Error('请选择内置脚本')
  const deviceIds = [...new Set(Array.isArray(input.deviceIds) ? input.deviceIds : [])]
  if (!deviceIds.length || deviceIds.length > 32 || deviceIds.some(id => typeof id !== 'string' || !id || id.length > 256 || /[\s\0]/.test(id)))
    throw new Error('请选择 1–32 台在线手机')
  const noLinks = ['jd-check', 'vip-coupon'].includes(input.scriptId)
  const items = noLinks ? [] : input.items
  if (!Array.isArray(items) || (!noLinks && !items.length) || items.length > 100)
    throw new Error('请先识别 1–100 条京东链接')
  const clean = items.map((item) => {
    if (typeof item?.url !== 'string' || item.url.length > 8192 || !['auto', 'coupon', 'product'].includes(item.kind))
      throw new Error('链接或类型无效')
    const url = new URL(item.url)
    const http = ['http:', 'https:'].includes(url.protocol)
    const host = url.hostname.toLowerCase()
    const official = host === 'jd.com' || host.endsWith('.jd.com') || host === '3.cn' || host.endsWith('.3.cn')
    if (/[\x00-\x20]/.test(item.url) || url.username || url.password || (http ? !official || !['', '80', '443'].includes(url.port) : !['openapp.jdmobile:', 'openjd:'].includes(url.protocol)))
      throw new Error('仅支持京东官方链接')
    return { url: item.url, kind: item.kind }
  })
  if (input.scriptId === 'jd-coupon' && clean.some(item => item.kind === 'product'))
    throw new Error('仅领券脚本不接受商品链接，请切换脚本或移除商品')
  let vip
  if (input.scriptId === 'vip-coupon') {
    if (deviceIds.length > 8)
      throw new Error('唯品会定时任务每批最多 8 台手机')
    const keyword = String(input.vip?.keyword || '').trim()
    const activityText = String(input.vip?.activityText || '').trim()
    const claimAt = Number(input.vip?.claimAt)
    if (!keyword || !activityText || keyword.length > 80 || activityText.length > 100 || /[\x00-\x1F]/.test(keyword + activityText))
      throw new Error('请填写搜索关键词和活动识别文字')
    if (!Number.isFinite(claimAt) || claimAt < Date.now() - 86400000 || claimAt > Date.now() + 172800000)
      throw new Error('请选择今天或未来两天内的放券时间')
    vip = { keyword, activityText, claimAt, prepareOnly: input.vip?.prepareOnly === true, refresh: input.vip?.refresh !== false }
  }
  return { scriptId: input.scriptId, deviceIds, items: clean, commissionEntry: String(input.commissionEntry || '').slice(0, 8192), vip }
}

export function finalizeInterruptedState(state = {}) {
  return {
    ...state,
    running: false,
    paused: false,
    pause_options: [],
    message: '任务已中断，已发出的操作请在手机核对；不会自动重新执行。',
    items: (state.items || []).map(item => ['pending', 'opening'].includes(item.status)
      ? { ...item, status: item.status === 'pending' ? 'stopped' : 'uncertain', message: '任务中断，请核对手机结果' }
      : item),
  }
}

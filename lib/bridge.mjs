/**
 * lib/bridge.mjs —— DSHA 设备桥（127.0.0.1:3090）的最小客户端
 * ============================================================================
 * 只做三件事：读 dump、点按、截屏。token 从 ~/.dsh/.bridge_token 读。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DSH_BRIDGE_URL || 'http://127.0.0.1:3090/app'
const TIMEOUT = Number(process.env.DSH_BRIDGE_TIMEOUT || 20000)

let cached = ''
export function token() {
  if (cached) return cached
  if (process.env.DSH_BRIDGE_TOKEN) return (cached = process.env.DSH_BRIDGE_TOKEN.trim())
  const candidates = [
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.bridge_token'),
    '/root/.dsh/.bridge_token',
  ]
  for (const p of candidates) {
    try {
      const t = readFileSync(p, 'utf8').trim()
      if (t) return (cached = t)
    } catch { /* 下一个 */ }
  }
  throw new Error('读不到 bridge token（找 ~/.dsh/.bridge_token）；DSHA 装了没？')
}

async function call(path, params = {}) {
  const u = new URL(BASE + path)
  u.searchParams.set('token', token())
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
  }
  const r = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT) })
  const txt = await r.text()
  let j
  try { j = JSON.parse(txt) } catch { return txt }
  if (j && j.result !== undefined) return j.result
  return txt
}

export const dump = () => call('/ui/dump')
export const tap = (x, y) => call('/ui/tap', { x: Math.round(x), y: Math.round(y) })
export const key = (name) => call('/ui/key', { name })
export const shot = () => call('/ui/screenshot')
export const swipe = (x1, y1, x2, y2, ms = 400) => call('/ui/swipe', { x1, y1, x2, y2, ms })
export const launch = (pkg) => call('/launch', { pkg })
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

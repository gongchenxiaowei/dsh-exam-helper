/**
 * lib/parse.mjs —— 把无障碍 dump 文本解析成「题目」
 * ============================================================================
 * 兼容两种常见形态：
 *   ① 知到 / 智慧树：选项是「单个字母节点 + 文本节点」，左对齐竖排，行距约 240~310px
 *   ② 超星 / 学习通：选项文本自带前缀（`选项A.透明度`），行是整块可点击
 *   ③ 判断题：`A对` / `B错` 粘在一个节点里
 * 坐标一律用 dump 给的真实中心点 —— 这是不点歪的关键。
 * ============================================================================
 */

const LETTERS = 'ABCDEFGH'
const NAV_WORDS = [
  ['prev', '上一题'],
  ['next', '下一题'],
  ['card', '题卡'],
  ['card', '答题卡'],
  ['submit', '提交作业'],
  ['submit', '交卷'],
  ['submit', '提交'],
]

const isHexId = (s) => /^[0-9a-f_]{20,}$/.test(s)
const isClock = (s) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(s)
const isScore = (s) => /^\d+(\.\d+)?分$/.test(s) || /^总分[:：]?\d+$/.test(s)

/** 文本 → { letter, text } ；不认识的返回 null */
function asOptionText(s) {
  let m = s.match(/^\s*选项\s*([A-H])\s*[.、:：]?\s*(.*)$/)
  if (m) return { letter: m[1], text: m[2].trim() }
  m = s.match(/^\s*([A-H])\s*[.、:：]\s*(.+)$/)
  if (m) return { letter: m[1], text: m[2].trim() }
  m = s.match(/^\s*([A-H])\s*(对|错)\s*$/)
  if (m) return { letter: m[1], text: m[2] }
  return null
}

/**
 * @param {string} text dump 结果
 * @returns {{type:string|null, stem:string, options:Array<{letter:string,text:string,x:number,y:number}>, nav:Object, progress:Object|null, app:string|null, raw:string[]}}
 */
export function parseDump(text) {
  const out = {
    app: null,
    type: null,
    stem: '',
    options: [],
    nav: {},
    progress: null,
    raw: [],
  }
  if (!text) return out

  const lines = String(text).split('\n')
  const items = []
  for (const line of lines) {
    const app = line.match(/^窗口应用:\s*(\S+)/)
    if (app) { out.app = app[1]; continue }
    const m = line.match(/^\[(\d+)\]\s*(.*?)\s*中心=\((\d+),\s*(\d+)\)/)
    if (!m) continue
    const body = m[2].replace(/可点击/g, '').trim()
    const x = Number(m[3])
    const y = Number(m[4])
    const q = body.match(/^"([\s\S]*)"$/)
    items.push({ text: q ? q[1] : '', x, y, hasText: !!q })
  }

  const texts = []
  for (const it of items) {
    const s = (it.text || '').trim()
    if (!s) continue
    // 题型
    const t = s.match(/(\d+)\.\s*(单选题|多选题|判断题|填空题|简答题)\s*(?:[（(]([^)）]*)[)）])?/)
    if (t && !out.type) {
      out.type = t[2]
      out.seq = Number(t[1])
      continue
    }
    // 导航
    let navHit = null
    for (const [key, word] of NAV_WORDS) {
      if (s.includes(word)) { navHit = key; break }
    }
    if (navHit) {
      if (!out.nav[navHit]) out.nav[navHit] = { x: it.x, y: it.y }
      continue
    }
    // 进度：共N题 第M题
    const p = s.match(/共\s*(\d+)\s*题/)
    if (p) out.progress = { ...(out.progress || {}), total: Number(p[1]) }
    const p2 = s.match(/第\s*(\d+)\s*题/)
    if (p2) out.progress = { ...(out.progress || {}), index: Number(p2[1]) }
    if (/标记此题|下拉刷新|温馨提示|请以选项内容为准|javascript:void|vue-vuex|未知|^<.*>$/.test(s)) continue
    if (isHexId(s) || isClock(s) || isScore(s)) continue
    // 纯字母节点（知到的选项编号）
    if (/^[A-H]$/.test(s)) { texts.push({ ...it, letter: s, pureLetter: true }); continue }
    const opt = asOptionText(s)
    if (opt) { texts.push({ ...it, opt }); continue }
    texts.push({ ...it, plain: true })
  }

  // 组装选项：先纯字母 + 近邻文本；再「选项X」自带前缀的
  const used = new Set()
  for (const node of texts) {
    if (!node.pureLetter) continue
    const near = texts.find((o, i) => !used.has(i) && o.plain && o.y > node.y - 60 && o.y < node.y + 120)
    if (near) {
      used.add(texts.indexOf(near))
      out.options.push({ letter: node.letter, text: near.text.trim(), x: node.x, y: node.y })
    } else {
      out.options.push({ letter: node.letter, text: '', x: node.x, y: node.y })
    }
  }
  for (const node of texts) {
    if (node.opt) {
      out.options.push({ letter: node.opt.letter, text: node.opt.text, x: node.x, y: node.y })
    }
  }

  // 题干 = 最长的那条普通文本（且比任何一个选项都长）
  const plain = texts.filter((o) => o.plain && !used.has(texts.indexOf(o)))
  const maxOpt = out.options.reduce((n, o) => Math.max(n, o.text.length), 0)
  const candidates = plain
    .map((o) => ({ text: o.text.trim(), y: o.y }))
    .filter((o) => o.text.length >= Math.max(10, maxOpt) && !isHexId(o.text))
    .sort((a, b) => b.text.length - a.text.length)
  out.stem = candidates.length ? candidates[0].text : ''

  // 选项按视觉位置排序（选项顺序本身是随机的，但字母→位置的映射必须对）
  out.options.sort((a, b) => a.y - b.y || a.x - b.x)
  return out
}

/** 给模型看的紧凑视图 */
export function brief(q) {
  const opts = q.options.length
    ? q.options.map((o) => `  ${o.letter}: ${o.text || '(空)'}  [y=${o.y}]`).join('\n')
    : '  (这个页面没有可读选项：可能是图片题，用 exam_screen 看截图)'
  const nav = Object.keys(q.nav).join(' ') || '(无)'
  const prog = q.progress ? `进度 ${q.progress.index ?? '?'}/${q.progress.total ?? '?'}` : ''
  return [
    `应用 ${q.app || '?'} | 题型 ${q.type || '?'} | ${prog}`,
    `题干：${q.stem || '(未读到)'}`,
    opts,
    `导航按钮：${nav}`,
  ].join('\n')
}

/**
 * dsh-exam-helper —— 把「读屏答题」这件苦活做成 dsh 工具
 * ============================================================================
 * 解决的是什么：靠模型目测坐标点选项，页面一滚动就点歪、选项顺序随机还会对不上号。
 * 这里把**机械部分**固化下来：
 *   - exam_state   读当前题（题型/题干/选项/导航/进度），坐标全用无障碍树给的真实中心点
 *   - exam_pick    按字母或按内容选（可多选），选完回报当前状态
 *   - exam_next / exam_prev   翻页（文字节点优先，没有就走截图像素兜底）
 *   - exam_screen  截图（图片题/公式题给模型看）
 *   - exam_submit  **必须 confirm:true** 才会点提交，先点「提交作业/交卷」再点确认
 *
 * 不做的：不内置答案、不替模型判断对错、不自动提交。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { dump, tap, shot, launch, sleep, key } from './lib/bridge.mjs'
import { parseDump, brief } from './lib/parse.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

export const name = 'exam-helper'
export const inject = ['tools']

const FINDER = join(here, 'lib', 'finder.py')

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => resolve({ ok: false, error: String(e?.message || e) }))
    p.on('close', (code) => resolve({ ok: code === 0, code, out, err }))
    setTimeout(() => { try { p.kill() } catch { /* noop */ } }, 25000)
  })
}

/** 截图 → 像素检测（H5 页面没有可读节点时的兜底） */
async function findRows(pngPath) {
  const r = await run('python3', [FINDER, pngPath])
  if (!r.ok) return { ok: false, error: (r.error || r.err || 'finder failed').slice(0, 300) }
  try {
    const j = JSON.parse(r.out.trim().split('\n').pop())
    return { ok: true, ...j }
  } catch (e) {
    return { ok: false, error: 'finder 输出不是 JSON：' + String(r.out).slice(0, 200) }
  }
}

/** 拿到一张截图文件路径 */
async function shotPath() {
  const raw = String(await shot())
  const m = raw.match(/(\/storage\/\S+?\.(?:png|jpg|webp))/)
  return m ? m[1] : null
}

async function state() {
  const q = parseDump(await dump())
  return q
}

export default function apply(ctx) {
  // 宿主 defineTool 要求 output（schema + render）；统一走文本渲染
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  // 宿主只吃无损 JSON：函数/循环引用/类实例都会把它顶回来
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'exam_state',
    description: '读当前屏幕上的题目：题型、题干、选项（字母+内容+真实纵坐标）、导航按钮、进度。'
      + '做作业/考试时先调它，再决定答案；不要凭截图猜坐标。',
    parameters: {},
    async execute() {
      const q = await state()
      return {
        ok: true,
        app: q.app,
        type: q.type,
        seq: q.seq ?? null,
        progress: q.progress ?? null,
        stem: q.stem,
        options: q.options.map((o) => ({ letter: o.letter, text: o.text, y: o.y })),
        nav: Object.fromEntries(Object.entries(q.nav).map(([k, v]) => [k, v.y])),
        rendered: brief(q),
        hint: q.options.length ? undefined : '这页没有可读选项：用 exam_screen 截图看，或用 exam_pick 走像素兜底',
      }
    },
  })

  tool({
    name: 'exam_pick',
    description: '选选项。letters 传字母串（如 "AC"）；单选传一个即可。'
      + '会自动把选项顺序（每次刷新可能随机）对回内容，点真实节点坐标。'
      + 'match 传文字片段时按内容匹配（更稳，适合选项乱序 + 记忆里只有内容的场景）。',
    parameters: {
      letters: { type: 'string', description: '要选的字母，如 "A" 或 "ACD"' },
      match: { type: 'string', description: '按内容片段选（和 letters 二选一）' },
      verify: { type: 'boolean', description: '选完自动回读一次状态（默认 true）' },
    },
    async execute(args) {
      const q = await state()
      const picked = []
      const wantLetters = String(args.letters || '').toUpperCase().replace(/[^A-H]/g, '')
      const wantMatch = String(args.match || '').trim()

      if (!q.options.length) {
        // 兜底：截图像素找行，按顺序点
        const p = await shotPath()
        if (!p) return { ok: false, error: '截图失败' }
        const f = await findRows(p)
        if (!f.ok) return { ok: false, error: f.error }
        const rows = f.rows || []
        const idx = wantLetters.split('').map((L) => 'ABCDEFGH'.indexOf(L))
        for (const i of idx) {
          if (i < 0 || i >= rows.length) continue
          await tap(720, rows[i].y)
          picked.push({ letter: 'ABCDEFGH'[i], y: rows[i].y, via: 'pixel' })
          await sleep(700)
        }
        if (!picked.length) return { ok: false, error: `像素兜底只找到 ${rows.length} 行，选不出 ${wantLetters}` }
        return { ok: true, picked, note: '这页没有文字节点，走的是截图像素兜底' }
      }

      let targets = []
      if (wantMatch) {
        targets = q.options.filter((o) => o.text.includes(wantMatch))
      } else {
        targets = wantLetters.split('').map((L) => q.options.find((o) => o.letter === L)).filter(Boolean)
      }
      if (!targets.length) {
        return { ok: false, error: '没找到要选的选项', options: q.options.map((o) => `${o.letter}:${o.text}`) }
      }
      for (const o of targets) {
        await tap(720, o.y)
        picked.push({ letter: o.letter, text: o.text, y: o.y })
        await sleep(700)
      }
      if (args.verify === false) return { ok: true, picked }

      await sleep(600)
      const after = await state()
      return {
        ok: true,
        picked,
        rendered: brief(after),
        optionsNow: after.options.map((o) => ({ letter: o.letter, text: o.text })),
      }
    },
  })

  tool({
    name: 'exam_next',
    description: '下一题。会先找「下一题」按钮；没有就说明是最后一题（该交卷了）。点完自动回读状态。',
    parameters: {},
    async execute() {
      const q = await state()
      const n = q.nav.next
      if (!n) {
        return { ok: false, error: '没找到「下一题」：可能已是最后一题，用 exam_submit 交卷', rendered: brief(q) }
      }
      await tap(n.x, n.y)
      await sleep(1800)
      let after = await state()
      if (!after.options.length && !after.stem) {
        await sleep(1500)
        after = await state()
      }
      return { ok: true, rendered: brief(after), seq: after.seq ?? null, progress: after.progress ?? null }
    },
  })

  tool({
    name: 'exam_prev',
    description: '上一题（回去补漏答的题）。点完自动回读状态。',
    parameters: {},
    async execute() {
      const q = await state()
      const p = q.nav.prev
      if (!p) return { ok: false, error: '没找到「上一题」', rendered: brief(q) }
      await tap(p.x, p.y)
      await sleep(1600)
      const after = await state()
      return { ok: true, rendered: brief(after), seq: after.seq ?? null, progress: after.progress ?? null }
    },
  })

  tool({
    name: 'exam_screen',
    description: '截当前屏并返回图片路径（图片题、公式题、题干被浮窗挡住时用；配合 read_image 看）。'
      + 'crop 传 "top"/"options"/"full" 控制裁剪范围。',
    parameters: {
      crop: { type: 'string', description: 'top / options / full（默认 full）' },
    },
    async execute(args) {
      const p = await shotPath()
      if (!p) return { ok: false, error: '截图失败（系统可能拒了一次，等 2 秒再试）' }
      const crop = String(args.crop || 'full')
      const out = p.replace(/\.(png|jpg|webp)$/, `-${crop}.png`)
      const box = crop === 'top' ? '0,0,1440,1400' : crop === 'options' ? '0,700,1440,2400' : '0,0,1440,3168'
      const r = await run('python3', ['-c',
        'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]);im.crop(tuple(int(v) for v in sys.argv[3].split(","))).save(sys.argv[2])',
        p, out, box])
      return { ok: true, path: r.ok ? out : p, crop }
    },
  })

  tool({
    name: 'exam_submit',
    description: '交卷。**必须传 confirm:true** 才会动作：先点「提交作业/交卷」，再点弹窗里的「确认」。'
      + '只在用户明确同意提交时用。',
    parameters: {
      confirm: { type: 'boolean', description: '用户已授权提交时传 true' },
    },
    async execute(args) {
      if (args.confirm !== true) {
        return { ok: false, error: '没有 confirm:true，不提交。先问用户，得到明确同意再调。' }
      }
      const q = await state()
      const s = q.nav.submit
      if (!s) return { ok: false, error: '当前页面没有「提交作业/交卷」按钮', rendered: brief(q) }
      await tap(s.x, s.y)
      await sleep(1800)
      // 弹窗里的「确认 / 确定」
      const txt = await dump()
      const m = txt.match(/\[(\d+)\]\s*"(确认|确定)"[^]*?中心=\((\d+),\s*(\d+)\)/)
      if (!m) {
        return { ok: false, error: '点了提交但没看到确认弹窗（可能已经提交，或弹窗文案不一样）', sample: String(txt).slice(0, 400) }
      }
      await tap(Number(m[3]), Number(m[4]))
      await sleep(2500)
      const after = await state()
      return { ok: true, submitted: true, rendered: brief(after) }
    },
  })

  tool({
    name: 'exam_open',
    description: '把学习通/知到切到前台（答题前确保对的是它，别点到 DSH 自己的浮窗）。',
    parameters: {
      app: { type: 'string', description: 'chaoxing | zhidao，默认 zhidao' },
    },
    async execute(args) {
      const a = String(args.app || 'zhidao').toLowerCase()
      const pkg = a.startsWith('chao') ? 'com.chaoxing.mobile' : 'com.able.wisdomtree'
      await launch(pkg)
      await sleep(2500)
      const after = await state()
      return { ok: true, pkg, app: after.app, rendered: brief(after) }
    },
  })

  ctx.logger?.info?.('exam-helper 已就绪：exam_state / exam_pick / exam_next / exam_prev / exam_screen / exam_submit / exam_open')
}

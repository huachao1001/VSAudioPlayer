// webview 前端：渲染波形图、显示时间、添加/同步播放
import WaveSurfer from 'wavesurfer.js'

// 播放/暂停 SVG 图标：圆底跟随 currentColor（由 .play 的 color 控制成主题绿），符号白色
const SVG_PLAY = `<svg viewBox="0 0 1024 1024" width="128" height="128" aria-hidden="true"><path d="M512.512 512m-418.8672 0a418.8672 418.8672 0 1 0 837.7344 0 418.8672 418.8672 0 1 0-837.7344 0Z" fill="currentColor"/><path d="M683.6224 470.016l-231.424-133.5808c-32.3072-18.6368-72.704 4.6592-72.704 41.984v267.2128c0 37.3248 40.3968 60.6208 72.704 41.984l231.424-133.5808c32.3072-18.7392 32.3072-65.3312 0-84.0192z" fill="#ffffff"/></svg>`
const SVG_PAUSE = `<svg viewBox="0 0 1024 1024" width="128" height="128" aria-hidden="true"><path d="M512.512 512m-418.8672 0a418.8672 418.8672 0 1 0 837.7344 0 418.8672 418.8672 0 1 0-837.7344 0Z" fill="currentColor"/><rect x="360" y="330" width="95" height="364" rx="24" fill="#ffffff"/><rect x="569" y="330" width="95" height="364" rx="24" fill="#ffffff"/></svg>`

// 将 CSS 颜色转为带透明度的 rgba，供波形半透明显示底层刻度线
function withAlpha(color: string, alpha: number): string {
  const c = color.trim()
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(c)
  if (rgba) {
    const p = rgba[1].split(/[,\/\s]+/).filter(Boolean).map(Number)
    if (p.length >= 3 && p.slice(0, 3).every((n) => !isNaN(n))) {
      const a = p.length > 3 && !isNaN(p[3]) ? p[3] : 1
      return `rgba(${p[0]},${p[1]},${p[2]},${a * alpha})`
    }
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    if (![r, g, b].some(isNaN)) return `rgba(${r},${g},${b},${alpha})`
  }
  return c
}

// 读取主题配色：未播放=前景色（暗白/亮黑自动跟随），已播放=提亮一档的绿，播放头=中性灰
function themeColors(): { wave: string; progress: string; cursor: string } {
  const cs = getComputedStyle(document.body)
  const accent = (cs.getPropertyValue('--ap-accent').trim()) || '#22c55e'
  const progress = (cs.getPropertyValue('--ap-progress').trim()) || accent
  const cursor = (cs.getPropertyValue('--vscode-descriptionForeground').trim()) || '#888'
  // body.color 即 --vscode-foreground：暗主题近白、亮主题近黑
  const wave = cs.color || '#d4d4d4'
  // 波形保留 10% 透明度，可透出网格参考线
  return { wave: withAlpha(wave, 0.9), progress: withAlpha(progress, 0.95), cursor }
}

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

interface Track {
  id: string
  name: string
  ws: WaveSurfer
  card: HTMLElement
  pcm?: { sampleRate: number; channels: number; dataType: string }
  reload: (dataUrl: string) => void
  redrawGrid: () => void
}

interface PcmInfo {
  sampleRate: number
  channels: number
  dataType: string
}

interface AddAudioMsg {
  type: 'addAudio'
  id: string
  name: string
  dataUrl: string
  pcm?: PcmInfo
}

interface DiagMsg {
  type: 'diag'
  text: string
}

interface RewrapAudioMsg {
  type: 'rewrapAudio'
  id: string
  dataUrl: string
}

interface I18nBundle {
  empty: string
  btnPlayPause: string
  diagReceived: string
  diagScriptLoaded: string
}

declare const __apI18n: I18nBundle

const vscode = acquireVsCodeApi()
const listEl = document.getElementById('list') as HTMLElement
const emptyEl = document.getElementById('empty') as HTMLElement

// {0}/{1} 占位替换，与 vscode.l10n 模板写法一致
function fmtStr(tpl: string, ...args: (string | number)[]): string {
  return tpl.replace(/\{(\d+)\}/g, (_, i: string) => String(args[+i] ?? ''))
}

const tracks: Track[] = []
let syncing = false

// PCM 头部下拉常用采样率；当前值不在列表里会自动补入
const PCM_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 96000, 192000]

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const ms = Math.floor((t % 1) * 1000)
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`
}

// 仅以第一个 track 作为同步时钟源，避免多 track 互相驱动造成循环
function isClock(ws: WaveSurfer): boolean {
  return tracks.length > 0 && tracks[0].ws === ws
}

function addTrack(id: string, name: string, dataUrl: string, pcm?: PcmInfo) {
  emptyEl.style.display = 'none'

  const card = document.createElement('div')
  card.className = 'track-wrap'
  card.innerHTML = `
    <div class="track-head">
      <span class="track-info"></span>
      <div class="track-name" title=""></div>
      <span class="track-time"><span class="cur">0:00.000</span> / <span class="dur">--:--.---</span></span>
    </div>
    <div class="track">
      <div class="wave"></div>
      <button class="play" title="${__apI18n.btnPlayPause}" aria-label="${__apI18n.btnPlayPause}">${SVG_PLAY}</button>
    </div>
  `
  const nameEl = card.querySelector('.track-name') as HTMLElement
  nameEl.textContent = name
  nameEl.setAttribute('title', name)
  listEl.appendChild(card)

  const box = card.querySelector('.track') as HTMLElement
  const waveEl = card.querySelector('.wave') as HTMLElement
  const playBtn = card.querySelector('.play') as HTMLButtonElement
  const curEl = card.querySelector('.cur') as HTMLElement
  const durEl = card.querySelector('.dur') as HTMLElement
  const infoEl = card.querySelector('.track-info') as HTMLElement

  // PCM 音轨：头部徽标改为三个下拉（通道/采样率/数据类型），任意改动即请求扩展重打包
  if (pcm) {
    const srSel = document.createElement('select')
    srSel.className = 'pcm-sr'
    const rates = [...PCM_SAMPLE_RATES]
    if (!rates.includes(pcm.sampleRate)) rates.push(pcm.sampleRate)
    rates.sort((a, b) => a - b)
    for (const r of rates) {
      const o = document.createElement('option')
      o.value = String(r)
      o.textContent = (r / 1000).toFixed(r % 1000 ? 1 : 0) + ' kHz'
      if (r === pcm.sampleRate) o.selected = true
      srSel.appendChild(o)
    }
    const chSel = document.createElement('select')
    chSel.className = 'pcm-ch'
    for (const c of [1, 2, 4, 6, 8]) {
      const o = document.createElement('option')
      o.value = String(c)
      o.textContent = c + 'ch'
      if (c === pcm.channels) o.selected = true
      chSel.appendChild(o)
    }
    const dtSel = document.createElement('select')
    dtSel.className = 'pcm-dt'
    for (const d of ['int16', 'fp32'] as const) {
      const o = document.createElement('option')
      o.value = d
      o.textContent = d
      if (d === pcm.dataType) o.selected = true
      dtSel.appendChild(o)
    }
    infoEl.innerHTML = ''
    infoEl.appendChild(chSel)
    const s1 = document.createElement('span'); s1.className = 'pcm-sep'; s1.textContent = '·'; infoEl.appendChild(s1)
    infoEl.appendChild(srSel)
    const s2 = document.createElement('span'); s2.className = 'pcm-sep'; s2.textContent = '·'; infoEl.appendChild(s2)
    infoEl.appendChild(dtSel)
    const fireRewrap = () => {
      vscode.postMessage({ type: 'rewrapPcm', id, sampleRate: parseInt(srSel.value, 10), channels: parseInt(chSel.value, 10), dataType: dtSel.value })
    }
    srSel.addEventListener('change', fireRewrap)
    chSel.addEventListener('change', fireRewrap)
    dtSel.addEventListener('change', fireRewrap)
  }

  const ws = WaveSurfer.create({
    container: waveEl,
    waveColor: themeColors().wave,
    progressColor: themeColors().progress,
    cursorColor: themeColors().cursor,
    height: 'auto',
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
  })

  // 悬浮竖线 + 时间气泡 + 拖拽改高度：全部基于外层 .wave-canvas，绝对定位不占流，避免干扰播放按钮对齐
  // 左侧预留 GUTTER 像素显示纵坐标刻度，波形从刻度区右侧开始
  const GUTTER = 32
  const waveHost = waveEl.firstElementChild as HTMLElement
  if (waveHost) {
    waveHost.style.width = `calc(100% - ${GUTTER}px)`
    waveHost.style.height = '100%'
    waveHost.style.marginLeft = GUTTER + 'px'
  }
  // 时间网格：叠在波形之下（z-index:1），主刻度全高竖线+时间标签、次刻度短竖线
  const grid = document.createElement('canvas')
  grid.className = 'wave-grid'
  waveEl.appendChild(grid)
  let gridDuration = 0
  const drawGrid = () => {
    const dpr = window.devicePixelRatio || 1
    const w = waveEl.clientWidth
    const h = waveEl.clientHeight
    grid.width = Math.round(w * dpr)
    grid.height = Math.round(h * dpr)
    grid.style.width = w + 'px'
    grid.style.height = h + 'px'
    const ctx = grid.getContext('2d')
    // 波形区从 GUTTER 开始，刻度标签画在左侧留白
    const gx = GUTTER
    const gw = w - gx
    if (!ctx || gridDuration <= 0 || gw <= 10 || h <= 0) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // 自适应步长：时长/步长 ≤ 12，避免刻度过密
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
    let step = steps[steps.length - 1]
    for (const s of steps) {
      if (gridDuration / s <= 12) { step = s; break }
    }
    const minor = step / 5
    const fmtTick = (t: number) => {
      if (step < 1) return t.toFixed(1)
      const m = Math.floor(t / 60)
      const sec = (t % 60).toFixed(0).padStart(2, '0')
      return m + ':' + sec
    }
    // 主题彩色刻度：参考线用强调绿，零轴线用暖橙，时间竖线用蓝色
    const cs = getComputedStyle(document.body)
    const warm = cs.getPropertyValue('--ap-warm').trim() || '#ea580c'
    const yellow = '#eab308'
    // 水平零轴线
    ctx.strokeStyle = withAlpha(warm, 0.55)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(gx, h / 2)
    ctx.lineTo(w, h / 2)
    ctx.stroke()
    // 纵坐标参考线（±1/±0.5，normalize 后峰值即 1）+ 左侧刻度标签
    ctx.font = '10px ' + (window.getComputedStyle(document.body).fontFamily || 'sans-serif')
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const levels: Array<[number, string]> = [[1, '1.0'], [0.5, '+0.5'], [-0.5, '-0.5'], [-1, '-1.0']]
    for (const [v, label] of levels) {
      const y = h / 2 - (v * h) / 2
      // 参考线夹在画布内，避免 ±1 贴边被裁掉一半
      const ly = Math.min(Math.max(y, 0.5), h - 0.5)
      ctx.strokeStyle = withAlpha(yellow, 0.3)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(gx, ly)
      ctx.lineTo(w, ly)
      ctx.stroke()
      // 刻度区右缘短刻度线
      ctx.beginPath()
      ctx.moveTo(gx - 4, ly)
      ctx.lineTo(gx, ly)
      ctx.stroke()
      // 标签纵向夹入画布（10px 字体中基线约需 7px 余量）
      const ty = Math.min(Math.max(y, 7), h - 7)
      // 描边避免被波形盖住
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,.45)'
      ctx.strokeText(label, 6, ty)
      ctx.fillStyle = 'rgba(234,179,8,.95)'
      ctx.fillText(label, 6, ty)
    }
    ctx.setLineDash([])
    // 零刻度标签
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0,0,0,.45)'
    ctx.strokeText('0', 6, h / 2)
    ctx.fillStyle = 'rgba(234,179,8,.95)'
    ctx.fillText('0', 6, h / 2)
    // 次刻度短竖线
    ctx.strokeStyle = withAlpha(yellow, 0.3)
    ctx.lineWidth = 1
    for (let t = 0; t <= gridDuration + 1e-6; t += minor) {
      const x = gx + (t / gridDuration) * gw
      ctx.beginPath()
      ctx.moveTo(x, h - 4)
      ctx.lineTo(x, h)
      ctx.stroke()
    }
    // 主刻度全高竖线 + 时间标签
    ctx.font = '10px ' + (window.getComputedStyle(document.body).fontFamily || 'sans-serif')
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (let t = 0; t <= gridDuration + 1e-6; t += step) {
      const x = gx + (t / gridDuration) * gw
      ctx.strokeStyle = withAlpha(yellow, 0.5)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()
      if (t === 0) continue // 左下角与纵坐标 -1.0 标签重叠，不画 0 刻度
      const label = fmtTick(t)
      // 描边避免被波形盖住
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,.45)'
      ctx.strokeText(label, x, h - 6)
      ctx.fillStyle = 'rgba(234,179,8,.95)'
      ctx.fillText(label, x, h - 6)
    }
  }
  const ro = new ResizeObserver(() => { drawGrid(); placeMark() })
  ro.observe(waveEl)
  const hoverLine = document.createElement('div')
  hoverLine.className = 'hover-line'
  const hoverTip = document.createElement('div')
  hoverTip.className = 'hover-tip'
  // 点击标记：记住播放起点，持续显示竖线
  const markLine = document.createElement('div')
  markLine.className = 'mark-line'
  const markTag = document.createElement('div')
  markTag.className = 'mark-tag'
  const resizer = document.createElement('div')
  resizer.className = 'wave-resizer'
  waveEl.appendChild(hoverLine)
  waveEl.appendChild(hoverTip)
  waveEl.appendChild(markLine)
  waveEl.appendChild(markTag)
  box.appendChild(resizer)
  let markTime: number | null = null
  // 屏幕坐标 → 播放进度比例：扣除左侧刻度区，范围限定在波形区内
  const ratioFromX = (x: number, width: number) => {
    const usable = width - GUTTER
    return usable > 0 ? Math.min(Math.max((x - GUTTER) / usable, 0), 1) : 0
  }
  const onMove = (ev: MouseEvent) => {
    const rect = waveEl.getBoundingClientRect()
    const x = ev.clientX - rect.left
    if (x < GUTTER || x > rect.width) return
    const ratio = ratioFromX(x, rect.width)
    const duration = ws.getDuration() || 0
    hoverLine.style.left = x + 'px'
    hoverLine.style.display = 'block'
    // 先显示再测量，拿到真实宽度后做边界吸附
    hoverTip.textContent = fmt(ratio * duration)
    hoverTip.style.display = 'block'
    const tipW = hoverTip.offsetWidth || 50
    let tx = x
    if (x - tipW / 2 < GUTTER) tx = GUTTER + tipW / 2
    else if (x + tipW / 2 > rect.width) tx = rect.width - tipW / 2
    hoverTip.style.left = tx + 'px'
  }
  const onLeave = () => {
    hoverLine.style.display = 'none'
    hoverTip.style.display = 'none'
  }
  waveEl.addEventListener('mousemove', onMove)
  waveEl.addEventListener('mouseleave', onLeave)
  // 拖拽底部 handle 改 .wave 高度，canvas 用 height:auto 自动跟随
  const onResizeDown = (ev: MouseEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
    const startY = ev.clientY
    const startH = waveEl.offsetHeight
    let raf = 0
    // height:'auto' 读取 parent.clientHeight，但 ResizeObserver 监听 shadow 内的 .scroll，
    // 纯高度变化不会触发重绘，需手动 setOptions 让波形跟随
    const apply = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        ws.setOptions({ height: 'auto' })
      })
    }
    const onMove2 = (e: MouseEvent) => {
      const dy = e.clientY - startY
      const h = Math.max(40, startH + dy)
      waveEl.style.height = h + 'px'
      apply()
    }
    const onUp2 = () => {
      document.removeEventListener('mousemove', onMove2)
      document.removeEventListener('mouseup', onUp2)
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      ws.setOptions({ height: 'auto' })
    }
    document.addEventListener('mousemove', onMove2)
    document.addEventListener('mouseup', onUp2)
  }
  resizer.addEventListener('mousedown', onResizeDown)

  // 按 markTime 重定位标记线/tag：点击设置后，窗口缩放时由 ResizeObserver 调用以保持位置正确
  function placeMark() {
    if (markTime === null) return
    const duration = ws.getDuration() || 0
    if (duration <= 0) return
    const rect = waveEl.getBoundingClientRect()
    if (rect.width <= 0) return
    const x = GUTTER + (markTime / duration) * (rect.width - GUTTER)
    markLine.style.left = x + 'px'
    markLine.style.display = 'block'
    markTag.textContent = fmt(markTime)
    markTag.style.display = 'block'
    const tagW = markTag.offsetWidth || 40
    let tx = x
    if (x - tagW / 2 < GUTTER) tx = GUTTER + tagW / 2
    else if (x + tagW / 2 > rect.width) tx = rect.width - tagW / 2
    markTag.style.left = tx + 'px'
  }

  // 点击波形：记录起点时间并显示标记竖线（WaveSurfer 自身会同时 seek 到该点）
  waveEl.addEventListener('click', (ev: MouseEvent) => {
    const tgt = ev.target as HTMLElement
    if (tgt && tgt.classList.contains('wave-resizer')) return
    const rect = waveEl.getBoundingClientRect()
    const x = ev.clientX - rect.left
    if (x < GUTTER || x > rect.width) return
    const ratio = ratioFromX(x, rect.width)
    const duration = ws.getDuration() || 0
    markTime = ratio * duration
    placeMark()
  })

  ws.load(dataUrl)

  const remove = () => {
    ws.destroy()
    ro.disconnect()
    const idx = tracks.findIndex((t) => t.card === card)
    if (idx >= 0) tracks.splice(idx, 1)
    card.remove()
    vscode.postMessage({ type: 'removeTrack', id })
    if (tracks.length === 0) {
      emptyEl.style.display = ''
      emptyEl.textContent = __apI18n.empty
    }
  }

  // info 徽标只放码率/通道/采样率，时间单独成徽标
  ws.on('ready', () => {
    const duration = ws.getDuration()
    durEl.textContent = fmt(duration)
    gridDuration = duration
    drawGrid()
    // PCM 音轨的 info 已由下拉框承担，这里只处理非 PCM 的解码信息
    if (pcm) return
    // 通道数与采样率取自解码后的 AudioBuffer
    const dec = ws.getDecodedData()
    const ch = dec ? dec.numberOfChannels : 0
    const sr = dec ? dec.sampleRate : 0
    const parts: string[] = []
    if (ch > 0) parts.push(ch + 'ch')
    if (sr > 0) parts.push((sr / 1000).toFixed(sr % 1000 ? 1 : 0) + ' kHz')
    infoEl.textContent = parts.join(' · ')
  })
  ws.on('timeupdate', (t: number) => {
    curEl.textContent = fmt(t)
    if (syncing && isClock(ws)) {
      for (const tr of tracks) {
        if (tr.ws !== ws) tr.ws.setTime(t)
      }
    }
  })
  ws.on('play', () => {
    playBtn.innerHTML = SVG_PAUSE
  })
  ws.on('pause', () => {
    playBtn.innerHTML = SVG_PLAY
  })
  ws.on('interaction', (newTime: number) => {
    if (syncing && isClock(ws)) {
      for (const tr of tracks) {
        if (tr.ws !== ws) tr.ws.setTime(newTime)
      }
    }
  })

  playBtn.onclick = () => {
    // 播放中则暂停；否则若有起点标记则从该处起播（同步模式下时钟源驱动其它 track）
    if (ws.isPlaying()) { ws.pause(); return }
    if (markTime !== null) {
      ws.setTime(markTime)
      if (syncing && isClock(ws)) {
        for (const tr of tracks) {
          if (tr.ws !== ws) tr.ws.setTime(markTime as number)
        }
      }
    }
    void ws.play()
  }

  // 重打包后用新 dataUrl 重新解码：清除起点标记、归零当前时间，避免旧时长残留
  const reload = (newDataUrl: string) => {
    markTime = null
    markLine.style.display = 'none'
    markTag.style.display = 'none'
    curEl.textContent = fmt(0)
    ws.load(newDataUrl)
  }

  tracks.push({ id, name, ws, card, pcm, reload, redrawGrid: drawGrid })
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as AddAudioMsg | DiagMsg | RewrapAudioMsg
  if (!msg) return
  if (msg.type === 'addAudio') {
    const _e = document.getElementById('empty')
    if (_e) _e.textContent = fmtStr(__apI18n.diagReceived, msg.name, msg.dataUrl.length)
    addTrack(msg.id, msg.name, msg.dataUrl, msg.pcm)
  } else if (msg.type === 'rewrapAudio') {
    const tr = tracks.find((t) => t.id === msg.id)
    if (tr) tr.reload(msg.dataUrl)
  } else if (msg.type === 'diag') {
    const _e = document.getElementById('empty')
    if (_e) { _e.style.display = ''; _e.textContent = msg.text }
  }
})

{
  const _e = document.getElementById('empty')
  if (_e) _e.textContent = __apI18n.diagScriptLoaded
}
// 主题切换时重设所有波形配色（VSCode 会改 body.class，canvas 需手动重画）
new MutationObserver(() => {
  const c = themeColors()
  for (const t of tracks) {
    t.ws.setOptions({ waveColor: c.wave, progressColor: c.progress, cursorColor: c.cursor })
    t.redrawGrid()
  }
}).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] })

vscode.postMessage({ type: 'ready' })

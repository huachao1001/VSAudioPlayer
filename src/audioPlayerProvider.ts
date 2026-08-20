import * as vscode from 'vscode'
import * as path from 'path'
import * as crypto from 'crypto'

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
  mp4: 'audio/mp4',
}

interface AudioPlayerDocument extends vscode.CustomDocument {}

interface PanelCtx {
  added: Set<string>
  pending: string[]
  ready: boolean
}

export class AudioPlayerProvider implements vscode.CustomEditorProvider<AudioPlayerDocument> {
  // 每个标签页的上下文：去重集合 + webview 就绪前缓存待发送的 uri
  private readonly editorCtx = new WeakMap<vscode.WebviewPanel, PanelCtx>()
  // 最近激活的播放器面板，供"添加到播放器"命令找目标 webview
  private activePanel: vscode.WebviewPanel | null = null
  private activeCtx: PanelCtx | null = null
  private readonly _onChange = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<AudioPlayerDocument> | vscode.CustomDocumentContentChangeEvent<AudioPlayerDocument>
  >()
  readonly onDidChangeCustomDocument = this._onChange.event

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<AudioPlayerDocument> {
    return { uri, dispose() {} }
  }

  // 标签页自身即播放器：设好 html 即返回，让 VS Code 尽快结束"打开编辑器"进度条。
  // 初始 uri 暂存 pending，待 webview 脚本发来 ready 后再 flush——自定义编辑器的
  // webview 不会在脚本就绪前缓存 postMessage，不发握手会丢消息导致一直空状态。
  async resolveCustomEditor(doc: AudioPlayerDocument, panel: vscode.WebviewPanel): Promise<void> {
    // custom editor 的 panel 由 VS Code 构造，enableScripts 默认 false（webviewOptions 不一定生效），
    // 必须在这里显式开启，否则 iframe sandbox 缺 allow-scripts，脚本被 Chrome 拦截。
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    }
    panel.webview.html = this.getHtml(panel.webview)
    const ctx: PanelCtx = { added: new Set<string>(), pending: [doc.uri.toString()], ready: false }
    this.editorCtx.set(panel, ctx)
    this.activePanel = panel
    this.activeCtx = ctx
    const disp = panel.webview.onDidReceiveMessage((msg) => this.onEditorMessage(msg, panel, ctx), null, this.context.subscriptions)
    panel.onDidDispose(() => {
      disp.dispose()
      if (this.activePanel === panel) { this.activePanel = null; this.activeCtx = null }
    }, null, this.context.subscriptions)
  }

  private async onEditorMessage(msg: { type: string; id?: string }, panel: vscode.WebviewPanel, ctx: PanelCtx) {
    if (msg.type === 'ready') {
      ctx.ready = true
      const uris = ctx.pending
      ctx.pending = []
      console.log('[AP] ready, flushing', uris.length)
      for (const u of uris) await this.sendAudioTo(vscode.Uri.parse(u), panel.webview, ctx.added)
      return
    }
    if (!ctx.ready) return
    if (msg.type === 'requestAddFile') {
      const picks = await vscode.window.showOpenDialog({
        canSelectMany: true,
        title: vscode.l10n.t('ext.title.selectAudio'),
        filters: { [vscode.l10n.t('ext.filters.audio')]: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'webm', 'opus', 'mp4'] },
      })
      if (!picks) return
      for (const u of picks) await this.sendAudioTo(u, panel.webview, ctx.added)
    } else if (msg.type === 'removeTrack' && msg.id) {
      ctx.added.delete(msg.id)
    }
  }

  async saveCustomDocument(): Promise<void> {}
  async saveCustomDocumentAs(): Promise<void> {}
  async revertCustomDocument(): Promise<void> {}
  async backupCustomDocument(): Promise<vscode.CustomDocumentBackup> {
    return { id: '', delete() {} }
  }

  // 把右键选中的音频 uri 发到最近激活的播放器面板；无面板则提示先打开一个
  async addUriToActivePanel(uri: vscode.Uri): Promise<void> {
    const panel = this.activePanel
    const ctx = this.activeCtx
    if (!panel || !ctx) {
      vscode.window.showInformationMessage(vscode.l10n.t('ext.info.openFirst'))
      return
    }
    if (!ctx.ready) { ctx.pending.push(uri.toString()); return }
    await this.sendAudioTo(uri, panel.webview, ctx.added)
  }

  // 去重 + 读取 + base64 + postMessage；VS Code 会在 webview 就绪前缓存消息
  private async sendAudioTo(uri: vscode.Uri, webview: vscode.Webview, added: Set<string>) {
    const key = uri.toString()
    if (added.has(key)) { console.log('[AP] skip dup', key); return }
    added.add(key)
    let buf: Uint8Array
    try {
      buf = await vscode.workspace.fs.readFile(uri)
    } catch (e) {
      console.log('[AP] readFile FAILED', key, e)
      await webview.postMessage({ type: 'diag', text: '[ext] ' + vscode.l10n.t('ext.diag.readFileFail') + String(e) })
      return
    }
    const base64 = Buffer.from(buf).toString('base64')
    const ext = path.extname(uri.fsPath).slice(1).toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    const dataUrl = `data:${mime};base64,${base64}`
    const name = path.basename(uri.fsPath)
    console.log('[AP] sending addAudio', name, 'bytes=', buf.length)
    await webview.postMessage({ type: 'addAudio', id: key, name, dataUrl })
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64')
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    )
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `media-src data: blob:`,
      `style-src 'unsafe-inline' ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src data: blob:`,
    ].join('; ')

    // webview 无法直接用 vscode.l10n，由扩展把本地化字符串注入到页面全局
    const i18n = JSON.stringify({
      empty: vscode.l10n.t('wv.empty'),
      btnPlayPause: vscode.l10n.t('wv.btn.playPause'),
      diagReceived: vscode.l10n.t('wv.diag.received'),
      diagScriptLoaded: vscode.l10n.t('wv.diag.scriptLoaded'),
    })
    const lang = /^zh/i.test(vscode.env.language) ? 'zh-CN' : 'en'

    return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<script nonce="${nonce}">window.__apI18n=${i18n};</script>
<style>
  /* 绿色主题主调：accent=交互绿（按钮/数字），progress=已播放绿（提亮一档，大面积填充不显沉），warm=标记暖橙 */
  body { --ap-accent: #22c55e; --ap-progress: #4ade80; --ap-warm: #f97316; }
  body.vscode-light { --ap-accent: #16a34a; --ap-progress: #22c55e; --ap-warm: #ea580c; }
  body.vscode-high-contrast { --ap-accent: #4ec9b0; --ap-progress: #6ee7b7; --ap-warm: #f97316; }
  body { margin:0; padding:22px 14px 12px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); font-size:13px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:0; padding:4px 12px; border-radius:2px; cursor:pointer; font-size:13px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.small { padding:2px 8px; }
  #list { display:flex; flex-direction:column; gap:48px; }
  .track-wrap { display:flex; flex-direction:column; gap:5px; }
  .track-head { display:flex; align-items:center; gap:8px; }
  .track-name { flex:1; order:2; font-weight:600; padding:0 2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; }
  .track-info { flex-shrink:0; order:1; font-size:13px; font-variant-numeric:tabular-nums; color: var(--vscode-descriptionForeground); border:1px solid var(--vscode-panel-border); background:transparent; border-radius:3px; padding:1px 8px; line-height:20px; white-space:nowrap; }
  .track-time { flex-shrink:0; order:3; font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; color: var(--vscode-descriptionForeground); border:1px solid var(--vscode-panel-border); border-radius:3px; padding:2px 12px; line-height:24px; white-space:nowrap; }
  .track-time .cur { color: var(--ap-accent); }
  .track { position:relative; display:flex; align-items:center; gap:10px; border:1px solid var(--vscode-panel-border); border-radius:4px; padding:6px 10px; transition: border-color .15s; }
  .track .play { flex-shrink:0; background:none; border:0; padding:0; cursor:pointer; line-height:0; border-radius:50%; color: var(--ap-accent); transition: filter .12s, transform .12s; }
  .track .play:hover { filter: brightness(1.15); transform: scale(1.06); }
  .track .play:active { transform: scale(.96); }
  .wave { flex:1; min-width:0; position:relative; height:156px; }
  .wave-grid { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:1; }
  .wave-resizer { position:absolute; left:-1px; right:-1px; bottom:-1px; height:8px; cursor:ns-resize; z-index:7; }
  .wave-resizer:hover { background: linear-gradient(to top, var(--ap-accent) 0, var(--ap-accent) 1px, transparent 1px); }
  .hover-line { position:absolute; top:0; left:0; width:1px; height:100%; background: var(--ap-accent); opacity:.7; pointer-events:none; display:none; z-index:5; }
  .hover-tip { position:absolute; top:2px; left:0; transform: translateX(-50%); background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); border:1px solid var(--ap-accent); border-radius:3px; padding:2px 6px; font-size:11px; font-variant-numeric:tabular-nums; white-space:nowrap; pointer-events:none; display:none; z-index:6; box-shadow:0 2px 6px rgba(0,0,0,.4); }
  .mark-line { position:absolute; top:0; left:0; width:2px; height:100%; background: var(--ap-warm); pointer-events:none; display:none; z-index:8; }
  .mark-tag { position:absolute; bottom:2px; left:0; transform: translateX(-50%); background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground); border:1px solid var(--ap-warm); border-radius:3px; padding:1px 5px; font-size:10px; font-variant-numeric:tabular-nums; white-space:nowrap; pointer-events:none; display:none; z-index:9; box-shadow:0 2px 6px rgba(0,0,0,.4); }
  #empty { padding:40px; text-align:center; color: var(--vscode-descriptionForeground); }
  .main { display:flex; gap:12px; align-items:flex-start; }
  .tracks { flex:1; min-width:0; }
</style>
</head>
<body>
  <div class="main">
    <div class="tracks">
      <div id="list"></div>
      <div id="empty"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

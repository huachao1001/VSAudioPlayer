import * as vscode from 'vscode'
import { AudioPlayerProvider } from './audioPlayerProvider'

export function activate(context: vscode.ExtensionContext) {
  const provider = new AudioPlayerProvider(context)
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('audioPlayer.audioEditor', provider, {
      webviewOptions: { enableScripts: true, retainContextWhenHidden: true },
    })
  )
  // 资源管理器右键"添加到 Audio Player"：把选中音频发到最近激活的播放器面板
  const addCmd = vscode.commands.registerCommand(
    'audioPlayer.addFile',
    async (uri: vscode.Uri) => {
      // 多选时 uri 是第一个；命令对每个选中项分别触发
      if (uri) await provider.addUriToActivePanel(uri)
    }
  )
  context.subscriptions.push(addCmd)
}

export function deactivate() {}

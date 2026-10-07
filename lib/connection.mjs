import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from './config.mjs';
import { loadLibrary } from './wiki.mjs';

const run = promisify(execFile);

export async function chooseVaultFolder(platform = process.platform, execute = run) {
  try {
    let command;
    let args;
    if (platform === 'darwin') {
      command = 'osascript';
      args = ['-e', 'POSIX path of (choose folder with prompt "选择 Markdown 资料库文件夹")'];
    } else if (platform === 'win32') {
      command = 'powershell.exe';
      args = ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = "Choose a Markdown folder"; if ($dialog.ShowDialog() -eq "OK") { $dialog.SelectedPath }'];
    } else {
      command = 'zenity';
      args = ['--file-selection', '--directory', '--title=选择 Markdown 资料库文件夹'];
    }
    const { stdout } = await execute(command, args, { timeout: 120_000, windowsHide: false });
    const folder = stdout.trim();
    if (!folder || !path.isAbsolute(folder)) throw new Error('未选择文件夹');
    return folder;
  } catch (error) {
    if (error.message === '未选择文件夹') throw error;
    if (error.code === 1 || error.code === 130) throw new Error('未选择文件夹');
    throw new Error('系统文件夹选择器不可用，请输入资料库的完整路径');
  }
}

export async function inspectConnection(input, appDir) {
  const folder = typeof input.path === 'string' ? input.path.trim() : '';
  if (!path.isAbsolute(folder) || folder.includes('\0')) throw new Error('请输入资料库的完整路径');
  const requestedContent = typeof input.contentDir === 'string' ? input.contentDir.trim() : '';
  const requestedDaily = typeof input.dailyDir === 'string' ? input.dailyDir.trim() : '';
  const args = ['--vault', folder];
  if (requestedContent) args.push('--content-dir', requestedContent);
  else if (await stat(path.join(folder, 'wiki')).then(info => info.isDirectory()).catch(() => false)) {
    args.push('--content-dir', 'wiki');
  }
  if (requestedDaily) args.push('--daily-dir', requestedDaily);
  if (input.writeDaily === true) args.push('--write-daily');
  const config = await resolveConfig(args, {}, appDir);
  const library = await loadLibrary(config.vault, config);
  if (!library.pages.length) throw new Error('该文件夹没有可读取的 Markdown 页面');
  const projects = library.pages.filter(page => page.type === 'project');
  return {
    config, library,
    preview: {
      path: config.vault,
      contentDir: config.contentDir || '',
      dailyDir: config.dailyDir,
      writeDaily: config.writeDaily,
      pageCount: library.pages.length,
      projectCount: projects.length,
      projects: projects.slice(0, 5).map(page => ({ path: page.path, title: page.title })),
      dailyTemplate: config.writeDaily ? 'valid' : 'not_checked'
    }
  };
}

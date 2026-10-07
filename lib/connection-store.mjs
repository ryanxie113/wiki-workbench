import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function connectionStorePath(environment = process.env, platform = process.platform) {
  const base = platform === 'win32'
    ? environment.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : environment.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'wiki-workbench', 'connection.json');
}

export function connectionArguments(saved) {
  if (!saved || typeof saved !== 'object' || typeof saved.path !== 'string' || !path.isAbsolute(saved.path)) return null;
  const args = ['--vault', saved.path];
  if (saved.contentDir) args.push('--content-dir', saved.contentDir);
  if (saved.dailyDir) args.push('--daily-dir', saved.dailyDir);
  if (saved.writeDaily === true) args.push('--write-daily');
  return args;
}

export async function readConnection(file = connectionStorePath()) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

export async function saveConnection(preview, file = connectionStorePath()) {
  const contents = JSON.stringify({
    path: preview.path,
    contentDir: preview.contentDir,
    dailyDir: preview.dailyDir,
    writeDaily: preview.writeDaily
  }, null, 2);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
}

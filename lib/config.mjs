import { realpath, stat, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeDailyFormat } from './daily-format.mjs';
import { createTodayFromTemplate, validateDailyTemplate } from './daily.mjs';

const HELP = `Wiki Workbench

Usage: node server.mjs [options]

Options:
  --vault PATH          Markdown folder (default: examples/demo-vault)
  --content-dir PATH    Scan only this subfolder, plus the index and daily folder
  --daily-dir PATH      Daily notes folder (default: daily)
  --daily-format PATH   JSON file defining daily headings and priority labels
  --index PATH          Optional index page (default: index.md)
  --time-zone ZONE      IANA time zone for daily notes (default: system zone)
  --exclude PATH        Exclude a relative path; may be repeated
  --write-daily         Allow creating and editing daily notes
  --port NUMBER         Local HTTP port (default: 4173)
  --help                Show this help
`;

function relativePath(value, option) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${option} 必须是资料库内的相对路径`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== value.replace(/\/$/, '')) {
    throw new Error(`${option} 包含无效路径`);
  }
  return normalized;
}

export function parseArguments(argv, environment = process.env, appDir = process.cwd()) {
  const values = {
    vault: environment.WIKI_WORKBENCH_VAULT || path.join(appDir, 'examples/demo-vault'),
    contentDir: null,
    dailyDir: 'daily',
    dailyFormatPath: null,
    indexPath: 'index.md',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    excludes: [],
    writeDaily: false,
    port: Number(environment.WORKBENCH_PORT || 4173)
  };
  const options = new Map([
    ['--vault', 'vault'], ['--content-dir', 'contentDir'], ['--daily-dir', 'dailyDir'], ['--daily-format', 'dailyFormatPath'],
    ['--index', 'indexPath'], ['--time-zone', 'timeZone'], ['--exclude', 'excludes'], ['--port', 'port']
  ]);
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--help') return { help: HELP };
    if (argument === '--write-daily') { values.writeDaily = true; continue; }
    const key = options.get(argument);
    if (!key || !argv[i + 1]) throw new Error(`未知参数或缺少值：${argument}`);
    const value = argv[++i];
    if (key === 'excludes') values.excludes.push(relativePath(value, argument));
    else values[key] = value;
  }
  values.vault = path.resolve(values.vault);
  if (values.contentDir) values.contentDir = relativePath(values.contentDir, '--content-dir');
  values.dailyDir = relativePath(values.dailyDir, '--daily-dir');
  values.indexPath = relativePath(values.indexPath, '--index');
  values.port = Number(values.port);
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) throw new Error('端口必须是 1–65535 的整数');
  try { new Intl.DateTimeFormat('en-US', { timeZone: values.timeZone }); }
  catch { throw new Error('无效的 IANA 时区'); }
  return values;
}

export async function resolveConfig(argv, environment, appDir) {
  const config = parseArguments(argv, environment, appDir);
  if (config.help) return config;
  const info = await stat(config.vault).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`资料库目录不存在：${config.vault}`);
  config.vault = await realpath(config.vault);
  if (config.dailyFormatPath) {
    let input;
    try { input = JSON.parse(await readFile(path.resolve(config.dailyFormatPath), 'utf8')); }
    catch (error) { throw new Error(`日报格式配置无法读取：${error.message}`); }
    config.dailyFormat = normalizeDailyFormat(input);
  } else config.dailyFormat = normalizeDailyFormat();
  if (config.contentDir) {
    const folder = path.join(config.vault, config.contentDir);
    const folderInfo = await stat(folder).catch(() => null);
    const canonical = await realpath(folder).catch(() => null);
    if (!folderInfo?.isDirectory() || !canonical?.startsWith(`${config.vault}${path.sep}`)) {
      throw new Error(`正文目录不存在或不在资料库内：${config.contentDir}`);
    }
  }
  if (config.writeDaily) {
    const dailyFolder = path.join(config.vault, config.dailyDir);
    const folderInfo = await lstat(dailyFolder).catch(() => null);
    const template = path.join(dailyFolder, '_template.md');
    const templateInfo = await lstat(template).catch(() => null);
    if (!folderInfo?.isDirectory() || !templateInfo?.isFile()) {
      throw new Error(`日报写入需要普通目录 ${config.dailyDir}/ 和 _template.md`);
    }
    validateDailyTemplate(createTodayFromTemplate(await readFile(template, 'utf8'), '2026-01-01'), config.dailyFormat);
  }
  return config;
}

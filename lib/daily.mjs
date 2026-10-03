import { readFile, writeFile, rename, unlink, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

export function zonedNow(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export const shanghaiNow = date => zonedNow('Asia/Shanghai', date);

function isoWeek(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

export function createTodayFromTemplate(template, dateText) {
  const day = new Date(`${dateText}T00:00:00Z`).getUTCDay();
  return template.replaceAll('YYYY-MM-DD', dateText)
    .replace(/^week: W$/m, `week: W${isoWeek(dateText)}`)
    .replace('周X', `周${'日一二三四五六'[day]}`)
    .replace('| 09:00 | | |', '');
}

export function parseToday(markdown, dateText, dailyDir = 'daily') {
  if (!markdown) return { date: dateText, exists: false, plans: [], records: [], path: `${dailyDir}/${dateText}.md` };
  const plans = [...markdown.matchAll(/^- \[([ xX])\] P([123]):[ \t]*(.*)$/gm)]
    .map(match => ({ priority: Number(match[2]), done: match[1].toLowerCase() === 'x', text: match[3].trim() }));
  const section = markdown.match(/## 时间线\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] || '';
  const records = [...section.matchAll(/^\|[ \t]*(\d{2}:\d{2})[ \t]*\|[ \t]*([^|\n]*)\|[ \t]*([^|\n]*)\|$/gm)]
    .map(match => ({ time: match[1], text: match[2].trim(), tag: match[3].trim() }))
    .filter(record => record.text);
  return { date: dateText, exists: true, plans, records, path: `${dailyDir}/${dateText}.md` };
}

function cleanCell(text, maxLength) {
  if (typeof text !== 'string') throw new Error('内容不能为空');
  const value = text.trim().replace(/[\r\n|]+/g, ' ');
  if (!value || value.length > maxLength) throw new Error(`内容应为 1–${maxLength} 字`);
  return value;
}

async function atomicReplace(filename, content) {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

let writeQueue = Promise.resolve();

export function updateToday(root, action, payload, library, config = {}) {
  const work = async () => {
    if (!config.writeDaily) throw new Error('日报写入未启用');
    const dailyDir = config.dailyDir || 'daily';
    const { date, time } = zonedNow(config.timeZone);
    const dailyFolder = path.join(root, dailyDir);
    const folderInfo = await lstat(dailyFolder).catch(() => null);
    const canonicalRoot = await realpath(root);
    const canonicalDaily = await realpath(dailyFolder).catch(() => null);
    if (!folderInfo?.isDirectory() || !canonicalDaily?.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error('日报目录不存在或不在资料库内');
    const filename = path.join(dailyFolder, `${date}.md`);
    const currentInfo = await lstat(filename).catch(() => null);
    if (currentInfo && !currentInfo.isFile()) throw new Error('今日日报不是普通文件');
    let markdown = await readFile(filename, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (action === 'init') {
      if (!markdown) {
        const template = await readFile(path.join(dailyFolder, '_template.md'), 'utf8');
        markdown = createTodayFromTemplate(template, date);
        await writeFile(filename, markdown, { flag: 'wx' });
      }
      return parseToday(markdown, date, dailyDir);
    }
    if (!markdown) throw new Error('请先初始化今日日报');
    if (action === 'plan') {
      const priority = Number(payload.priority);
      if (![1, 2, 3].includes(priority)) throw new Error('请选择 P1、P2 或 P3');
      const project = library.byPath.get(payload.projectPath);
      if (!project || project.type !== 'project') throw new Error('找不到关联项目');
      const text = cleanCell(payload.text, 180);
      if (!project.digest.action.includes(text)) throw new Error('项目记录已变化，请刷新后重试');
      const pattern = new RegExp(`^- \\[([ xX])\\] P${priority}:.*$`, 'm');
      if (!pattern.test(markdown)) throw new Error('今日计划格式不符合日报模板');
      markdown = markdown.replace(pattern, `- [ ] P${priority}: ${text} [[${project.id}]]`);
    } else if (action === 'record') {
      const project = library.byPath.get(payload.projectPath);
      if (!project || project.type !== 'project') throw new Error('请选择关联项目');
      const text = cleanCell(payload.text, 400);
      if (!markdown.includes('\n## 阅读')) throw new Error('今日日报缺少阅读区域');
      markdown = markdown.replace('\n## 阅读', `\n| ${time} | ${text} | [[${project.id}]] |\n\n## 阅读`);
    } else {
      throw new Error('未知操作');
    }
    await atomicReplace(filename, markdown);
    return parseToday(markdown, date, dailyDir);
  };
  const result = writeQueue.then(work);
  writeQueue = result.catch(() => {});
  return result;
}

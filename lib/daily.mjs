import { readFile, writeFile, rename, unlink, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { defaultDailyFormat } from './daily-format.mjs';

export function zonedNow(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function isoWeek(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

export function createTodayFromTemplate(template, dateText) {
  const day = new Date(`${dateText}T00:00:00Z`).getUTCDay();
  const week = `W${isoWeek(dateText)}`;
  const weekday = `周${'日一二三四五六'[day]}`;
  return template.replaceAll('{{date}}', dateText)
    .replaceAll('{{week}}', week)
    .replaceAll('{{weekday}}', weekday)
    .replaceAll('YYYY-MM-DD', dateText)
    .replace(/^week: W\r?$/m, `week: ${week}`)
    .replace('周X', weekday)
    .replace('| 09:00 | | |', '');
}

function sectionBounds(markdown, heading) {
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const headingAt = lines.findIndex(line => /^##\s+(.+)$/.exec(line)?.[1].trim() === heading);
  if (headingAt < 0) return null;
  let end = lines.findIndex((line, index) => index > headingAt && /^##\s+/.test(line));
  if (end < 0) end = lines.length;
  return { lines, start: headingAt + 1, end, newline };
}

function planPattern(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^-\\s+\\[([ xX])\\]\\s+${escaped}:[ \\t]*(.*)$`);
}

function planLine(lines, start, end, label) {
  for (let index = start; index < end; index++) {
    const match = planPattern(label).exec(lines[index]);
    if (match) return { index, match };
  }
  return null;
}

function hasTimelineTable(section) {
  if (!section) return false;
  const lines = section.lines.slice(section.start, section.end);
  return lines.some((line, index) => /^\s*\|(?:[^|]*\|){3}\s*$/.test(line)
    && /^\s*\|(?:\s*:?-{3,}:?\s*\|){3}\s*$/.test(lines[index + 1] || ''));
}

export function validateDailyTemplate(markdown, format = defaultDailyFormat) {
  const planSection = sectionBounds(markdown, format.planHeading);
  const timeline = sectionBounds(markdown, format.timelineHeading);
  if (!planSection || format.priorityLabels.some(label => !planLine(planSection.lines, planSection.start, planSection.end, label)) || !hasTimelineTable(timeline)) {
    throw new Error('日报模板缺少配置的计划项或时间线表格');
  }
}

export function parseToday(markdown, dateText, dailyDir = 'daily', format = defaultDailyFormat) {
  if (markdown === null || markdown === undefined) return { date: dateText, exists: false, plans: [], records: [], path: `${dailyDir}/${dateText}.md` };
  const planSection = sectionBounds(markdown, format.planHeading);
  const plans = planSection ? format.priorityLabels.flatMap((label, index) => {
    const line = planLine(planSection.lines, planSection.start, planSection.end, label);
    return line ? [{ priority: index + 1, label, done: line.match[1].toLowerCase() === 'x', text: line.match[2].trim() }] : [];
  }) : [];
  const timeline = sectionBounds(markdown, format.timelineHeading);
  const records = timeline ? timeline.lines.slice(timeline.start, timeline.end).flatMap(line => {
    const match = /^\|[ \t]*(\d{2}:\d{2})[ \t]*\|[ \t]*([^|\n]*)\|[ \t]*([^|\n]*)\|[ \t]*$/.exec(line);
    return match && match[2].trim() ? [{ time: match[1], text: match[2].trim(), tag: match[3].trim() }] : [];
  }) : [];
  return { date: dateText, exists: true, plans, records, path: `${dailyDir}/${dateText}.md` };
}

function cleanCell(text, maxLength) {
  if (typeof text !== 'string') throw new Error('内容不能为空');
  const value = text.trim().replace(/[\r\n|]+/g, ' ');
  if (!value || value.length > maxLength) throw new Error(`内容应为 1–${maxLength} 字`);
  return value;
}

async function atomicReplace(filename, content, mode = 0o600) {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
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
    const format = config.dailyFormat || defaultDailyFormat;
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
    const originalMarkdown = markdown;
    if (action === 'init') {
      if (markdown === null) {
        const templateFile = path.join(dailyFolder, '_template.md');
        if (!(await lstat(templateFile)).isFile()) throw new Error('日报模板不是普通文件');
        const template = await readFile(templateFile, 'utf8');
        markdown = createTodayFromTemplate(template, date);
        validateDailyTemplate(markdown, format);
        await writeFile(filename, markdown, { flag: 'wx', mode: 0o600 });
      }
      return parseToday(markdown, date, dailyDir, format);
    }
    if (markdown === null) throw new Error('请先初始化今日日报');
    if (action === 'plan') {
      const priority = Number(payload.priority);
      if (![1, 2, 3].includes(priority)) throw new Error('请选择有效的优先级');
      const project = library.byPath.get(payload.projectPath);
      if (!project || project.type !== 'project') throw new Error('找不到关联项目');
      const text = cleanCell(payload.text, 180);
      if (!project.digest.action.includes(text)) throw new Error('项目记录已变化，请刷新后重试');
      const section = sectionBounds(markdown, format.planHeading);
      const label = format.priorityLabels[priority - 1];
      const line = section && planLine(section.lines, section.start, section.end, label);
      if (!line) throw new Error('今日计划格式不符合日报模板');
      section.lines[line.index] = `- [ ] ${label}: ${text} [[${project.id}]]`;
      markdown = section.lines.join(section.newline);
    } else if (action === 'record') {
      const project = library.byPath.get(payload.projectPath);
      if (!project || project.type !== 'project') throw new Error('请选择关联项目');
      const text = cleanCell(payload.text, 400);
      const section = sectionBounds(markdown, format.timelineHeading);
      if (!hasTimelineTable(section)) throw new Error('日报时间线缺少表格');
      let insertion = section.end;
      while (insertion > section.start && !section.lines[insertion - 1].trim()) insertion--;
      section.lines.splice(insertion, 0, `| ${time} | ${text} | [[${project.id}]] |`);
      markdown = section.lines.join(section.newline);
    } else {
      throw new Error('未知操作');
    }
    const latest = await readFile(filename, 'utf8');
    if (latest !== originalMarkdown) throw new Error('今日日报已在外部更新，请刷新后重试');
    await atomicReplace(filename, markdown, currentInfo?.mode & 0o777);
    return parseToday(markdown, date, dailyDir, format);
  };
  const result = writeQueue.then(work);
  writeQueue = result.catch(() => {});
  return result;
}

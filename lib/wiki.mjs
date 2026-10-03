import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

const WIKI_TYPES = new Set(['project', 'concept', 'entity', 'source', 'insight', 'personal']);

export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return { attributes: {}, body: markdown };
  let parsed;
  try { parsed = YAML.parse(match[1], { uniqueKeys: true }); }
  catch { return { attributes: {}, body: markdown }; }
  const fields = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const values = key => Array.isArray(fields[key]) ? fields[key].filter(item => typeof item === 'string') : [];
  const date = key => typeof fields[key] === 'string' ? fields[key].slice(0, 10) : '';
  return {
    attributes: {
      type: typeof fields.type === 'string' ? fields.type : '',
      created: date('created'),
      updated: date('updated'),
      confidence: typeof fields.confidence === 'string' ? fields.confidence : '',
      sources: values('sources'),
      tags: values('tags')
    },
    body: markdown.slice(match[0].length)
  };
}

function plainText(line) {
  return line.replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1').trim();
}

function sectionsOf(body) {
  const lines = body.split(/\r?\n/);
  const headings = [];
  lines.forEach((line, index) => {
    const match = /^(#{2,4})\s+(.+)$/.exec(line);
    if (match) headings.push({ level: match[1].length, title: match[2].trim(), index });
  });
  return headings.map(heading => {
    const end = headings.find(next => next.index > heading.index && next.level <= heading.level)?.index ?? lines.length;
    return { ...heading, content: lines.slice(heading.index + 1, end).join('\n') };
  });
}

function firstUsefulLines(content, limit = 3) {
  return content.split(/\r?\n/)
    .map(plainText)
    .filter(line => line && !/^(相关页面|项目目标|当前风险)$/.test(line) && !/^\|[-: |]+\|$/.test(line))
    .slice(0, limit);
}

function nearestDate(section, sections, fallback) {
  const preceding = sections.filter(item => item.index <= section.index);
  for (let i = preceding.length - 1; i >= 0; i--) {
    const dates = [...preceding[i].title.matchAll(/20\d{2}-\d{2}-\d{2}/g)].map(match => match[0]);
    if (dates.length) return dates.at(-1);
  }
  return fallback || '';
}

export function projectDigest(page) {
  const sections = sectionsOf(page.body);
  const goal = sections.find(section => /^(项目目标|项目定位|目标|goal|objective)$/i.test(section.title));
  const dated = sections.filter(section => /20\d{2}-\d{2}-\d{2}/.test(section.title) && !/相关页面/.test(section.title));
  dated.sort((a, b) => {
    const da = [...a.title.matchAll(/20\d{2}-\d{2}-\d{2}/g)].at(-1)?.[0] || '';
    const db = [...b.title.matchAll(/20\d{2}-\d{2}-\d{2}/g)].at(-1)?.[0] || '';
    return db.localeCompare(da) || b.index - a.index;
  });
  const progress = dated.find(section => firstUsefulLines(section.content).length)
    || [...sections].reverse().find(section => /进展|当前状态|progress|status|updates/i.test(section.title) && firstUsefulLines(section.content).length);
  const action = [...sections].reverse().find(section => /下一步|下周计划|下周建议|待推进|Short-term TODO|next steps|todo/i.test(section.title) && firstUsefulLines(section.content).length);
  return {
    goal: goal ? firstUsefulLines(goal.content, 1)[0] || '' : '',
    progress: progress ? firstUsefulLines(progress.content, 3) : [],
    progressDate: progress ? nearestDate(progress, sections, page.attributes.updated) : page.attributes.updated || '',
    progressSourcePath: page.path,
    progressLine: progress ? progress.index + 1 : 0,
    action: action ? firstUsefulLines(action.content, 3) : [],
    actionDate: action ? nearestDate(action, sections, page.attributes.updated) : '',
    actionLine: action ? action.index + 1 : 0,
    progressHeading: progress?.title || '',
    actionHeading: action?.title || ''
  };
}

export function parsePage(relativePath, markdown, config = {}) {
  const { attributes, body } = parseFrontmatter(markdown);
  const title = (body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relativePath, '.md')).replace(/^Project:\s*/i, '');
  const isDaily = relativePath.startsWith(`${config.dailyDir || 'daily'}/`);
  const folder = path.posix.dirname(relativePath).split('/').at(-1);
  const type = isDaily ? 'daily' : relativePath === (config.indexPath || 'index.md') ? 'index'
    : WIKI_TYPES.has(attributes.type) ? attributes.type
      : folder === 'projects' ? 'project' : WIKI_TYPES.has(folder) ? folder : 'other';
  return {
    path: relativePath,
    id: path.basename(relativePath, '.md'),
    title,
    type,
    attributes,
    body,
    headings: [...body.matchAll(/^#{2,4}\s+(.+)$/gm)].map(match => match[1].trim()),
    digest: type === 'project' ? null : undefined
  };
}

async function markdownPaths(root, directory, config) {
  if (directory) {
    const canonicalRoot = await realpath(root);
    const canonicalDirectory = await realpath(path.join(root, directory)).catch(() => null);
    if (!canonicalDirectory?.startsWith(`${canonicalRoot}${path.sep}`)) return [];
  }
  const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const found = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (config.excludes?.some(excluded => relative === excluded || relative.startsWith(`${excluded}/`))) continue;
    if (entry.isDirectory()) found.push(...await markdownPaths(root, relative, config));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '_template.md') {
      const info = await stat(path.join(root, relative));
      if (info.size <= 3_000_000) found.push(relative);
    }
  }
  return found;
}

export async function loadLibrary(root, config = {}) {
  const dailyDir = config.dailyDir || 'daily';
  const indexPath = config.indexPath || 'index.md';
  const scanRoot = config.contentDir || '';
  const found = await markdownPaths(root, scanRoot, config);
  if (scanRoot) found.push(...await markdownPaths(root, dailyDir, config));
  if (await availableRepoFile(root, indexPath, config)) found.push(indexPath);
  const files = [...new Set(found)].sort();
  const pages = await Promise.all(files.map(async relative => parsePage(relative, await readFile(path.join(root, relative), 'utf8'), config)));
  for (const page of pages) if (page.type === 'project') page.digest = projectDigest(page);
  const weeklySummaries = pages.filter(page => page.type === 'insight' && /weekly-summary/.test(page.id))
    .sort((a, b) => (b.attributes.updated || '').localeCompare(a.attributes.updated || ''));
  const latestWeekly = weeklySummaries.find(page => sectionsOf(page.body).some(section => /^下周计划$/.test(section.title)));
  const weeklyPlanSection = latestWeekly && sectionsOf(latestWeekly.body).find(section => /^下周计划$/.test(section.title));
  const latestWeeklyPlan = weeklyPlanSection ? {
    path: latestWeekly.path,
    date: latestWeekly.attributes.updated || latestWeekly.attributes.created,
    heading: weeklyPlanSection.title,
    line: weeklyPlanSection.index + 1,
    items: firstUsefulLines(weeklyPlanSection.content, 5)
  } : null;
  const normalized = text => text.toLocaleLowerCase().replace(/^project:\s*/, '').replace(/[\s_-]/g, '');
  for (const project of pages.filter(page => page.type === 'project')) {
    for (const weekly of weeklySummaries) {
      const date = weekly.attributes.updated || weekly.attributes.created || '';
      if (date < project.digest.progressDate) break;
      const section = sectionsOf(weekly.body).find(item => item.level >= 3 && [project.id, project.title].some(name => normalized(name) === normalized(item.title)));
      if (!section) continue;
      const lines = firstUsefulLines(section.content, 3);
      if (!lines.length) continue;
      project.digest.progress = lines;
      project.digest.progressDate = date;
      project.digest.progressHeading = section.title;
      project.digest.progressSourcePath = weekly.path;
      project.digest.progressLine = section.index + 1;
      break;
    }
  }
  const indexText = pages.find(page => page.path === indexPath)?.body || '';
  const indexDescriptions = new Map([...indexText.matchAll(/^- \[\[([^\]|#]+)(?:\|[^\]]+)?\]\]\s*[—–-]\s*(.+)$/gm)]
    .map(match => [match[1], match[2].trim()]));
  for (const page of pages.filter(item => item.type === 'project')) {
    if (!page.digest.goal) page.digest.goal = indexDescriptions.get(page.id) || '';
  }
  const indexedIds = new Set([...indexText.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(match => match[1]));
  const byPath = new Map(pages.map(page => [page.path, page]));
  const byId = new Map();
  for (const page of pages) {
    const matches = byId.get(page.id) || [];
    matches.push(page.path);
    byId.set(page.id, matches);
  }
  const unindexed = indexText ? pages.filter(page => WIKI_TYPES.has(page.type) && !indexedIds.has(page.id)).map(page => ({ path: page.path, title: page.title })) : [];
  return { pages, byPath, byId, unindexed, latestWeeklyPlan };
}

export function searchLibrary(library, input, type = 'all', limit = 40) {
  const query = input.trim().toLocaleLowerCase();
  if (!query) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  return library.pages.filter(page => type === 'all' || page.type === type)
    .map(page => {
      const title = `${page.id} ${page.title}`.toLocaleLowerCase();
      const headings = page.headings.join(' ').toLocaleLowerCase();
      const body = page.body.toLocaleLowerCase();
      if (!terms.every(term => title.includes(term) || headings.includes(term) || body.includes(term))) return null;
      const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 12 : 0) + (headings.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0);
      const hit = terms.map(term => body.indexOf(term)).filter(position => position >= 0).sort((a, b) => a - b)[0] ?? 0;
      const excerpt = plainText(page.body.slice(Math.max(0, hit - 42), hit + 125).replace(/\s+/g, ' '));
      return { path: page.path, id: page.id, title: page.title, type: page.type, date: page.type === 'project' ? page.digest.progressDate || '' : page.attributes.updated || page.attributes.created || '', excerpt, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, limit);
}

export function safeVaultPath(relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0')) return null;
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== relative || normalized.split('/').some(part => part.startsWith('.'))) return null;
  return normalized;
}

export const safeRepoPath = safeVaultPath;

export async function availableRepoFile(root, relative, config = {}) {
  const safe = safeVaultPath(relative);
  if (!safe) return null;
  if (config.excludes?.some(excluded => safe === excluded || safe.startsWith(`${excluded}/`))) return null;
  const absolute = path.join(root, safe);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size > 3_000_000) return null;
  const canonical = await realpath(absolute).catch(() => null);
  const canonicalRoot = await realpath(root);
  if (!canonical?.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  return absolute;
}

export async function readAllowedFile(root, relative, config = {}) {
  const absolute = await availableRepoFile(root, relative, config);
  if (!absolute || !/\.(?:md|txt|json|jsonl|yaml|yml|py|csv|tsv)$/i.test(relative)) return null;
  return readFile(absolute, 'utf8');
}

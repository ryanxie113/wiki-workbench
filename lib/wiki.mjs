import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { normalizeProjectFormat, defaultProjectFormat } from './project-format.mjs';

const WIKI_TYPES = new Set(['project', 'concept', 'entity', 'source', 'insight', 'personal']);

export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return { attributes: {}, body: markdown, bodyLineOffset: 0 };
  let parsed;
  try { parsed = YAML.parse(match[1], { uniqueKeys: true }); }
  catch { return { attributes: {}, body: markdown, bodyLineOffset: 0 }; }
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
      tags: values('tags'),
      aliases: values('aliases')
    },
    body: markdown.slice(match[0].length),
    bodyLineOffset: (match[0].match(/\n/g) || []).length
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

function sectionEvidence(section, page, date, kind, limit = 3) {
  if (!section) return [];
  return section.content.split(/\r?\n/)
    .map((raw, index) => ({
      text: plainText(raw), sourcePath: page.path,
      line: page.bodyLineOffset + section.index + index + 2,
      date, kind, heading: section.title
    }))
    .filter(item => item.text && !/^(相关页面|项目目标|当前风险)$/.test(item.text) && !/^\|[-: |]+\|$/.test(item.text))
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

function matchesHeading(title, names) {
  const normalized = title.toLocaleLowerCase();
  return names.some(name => normalized === name.toLocaleLowerCase());
}

function includesHeading(title, names) {
  const normalized = title.toLocaleLowerCase();
  return names.some(name => normalized.includes(name.toLocaleLowerCase()));
}

export function projectDigest(page, format = defaultProjectFormat) {
  const sections = sectionsOf(page.body);
  const goal = sections.find(section => matchesHeading(section.title, format.goalHeadings));
  const dated = sections.filter(section => /20\d{2}-\d{2}-\d{2}/.test(section.title) && !/相关页面/.test(section.title));
  dated.sort((a, b) => {
    const da = [...a.title.matchAll(/20\d{2}-\d{2}-\d{2}/g)].at(-1)?.[0] || '';
    const db = [...b.title.matchAll(/20\d{2}-\d{2}-\d{2}/g)].at(-1)?.[0] || '';
    return db.localeCompare(da) || b.index - a.index;
  });
  const progress = dated.find(section => firstUsefulLines(section.content).length)
    || [...sections].reverse().find(section => includesHeading(section.title, format.progressHeadings) && firstUsefulLines(section.content).length);
  const action = [...sections].reverse().find(section => includesHeading(section.title, format.actionHeadings) && firstUsefulLines(section.content).length);
  const progressDate = progress ? nearestDate(progress, sections, page.attributes.updated) : page.attributes.updated || '';
  const actionDate = action ? nearestDate(action, sections, page.attributes.updated) : '';
  const goalEvidence = sectionEvidence(goal, page, page.attributes.updated || '', 'project', 1)[0] || null;
  const progressEvidence = sectionEvidence(progress, page, progressDate, 'project');
  const actionEvidence = sectionEvidence(action, page, actionDate, 'project');
  return {
    goal: goalEvidence?.text || '', goalEvidence,
    progress: progressEvidence.map(item => item.text), progressEvidence,
    progressDate,
    progressSourcePath: page.path,
    progressLine: progress ? page.bodyLineOffset + progress.index + 1 : 0,
    action: actionEvidence.map(item => item.text), actionEvidence,
    actionDate,
    actionLine: action ? page.bodyLineOffset + action.index + 1 : 0,
    progressHeading: progress?.title || '',
    actionHeading: action?.title || ''
  };
}

export function parsePage(relativePath, markdown, config = {}) {
  const { attributes, body, bodyLineOffset } = parseFrontmatter(markdown);
  const title = (body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relativePath, '.md')).replace(/^Project:\s*/i, '');
  const isDaily = relativePath.startsWith(`${config.dailyDir || 'daily'}/`);
  const folders = path.posix.dirname(relativePath).split('/');
  const folder = folders.at(-1);
  const inProjectDir = (config.projectDirs || []).some(directory => relativePath.startsWith(`${directory}/`));
  const type = isDaily ? 'daily' : relativePath === (config.indexPath || 'index.md') ? 'index'
    : WIKI_TYPES.has(attributes.type) ? attributes.type
      : folders.includes('projects') || inProjectDir ? 'project' : WIKI_TYPES.has(folder) ? folder : 'other';
  return {
    path: relativePath,
    id: path.basename(relativePath, '.md'),
    title,
    type,
    attributes,
    body, bodyLineOffset,
    headings: [...body.matchAll(/^#{2,4}\s+(.+)$/gm)].map(match => match[1].trim()),
    digest: type === 'project' ? null : undefined
  };
}

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

async function markdownPaths(root, directory, config, canonicalRoot) {
  if (directory) {
    const canonicalDirectory = await realpath(path.join(root, directory)).catch(() => null);
    if (!canonicalDirectory?.startsWith(`${canonicalRoot}${path.sep}`)) return [];
  }
  const entries = await readdir(path.join(root, directory), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const found = await mapLimited(entries, 32, async entry => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (config.excludes?.some(excluded => relative === excluded || relative.startsWith(`${excluded}/`))) return [];
    if (entry.isDirectory()) return markdownPaths(root, relative, config, canonicalRoot);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '_template.md') {
      const info = await stat(path.join(root, relative)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info && info.size <= 3_000_000) return [{ relative, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }];
    }
    return [];
  });
  return found.flat();
}

function sameFile(left, right) {
  return left && right && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function loadLibrary(root, config = {}, previous = null) {
  const projectFormat = normalizeProjectFormat(config.projectFormat);
  const dailyDir = config.dailyDir || 'daily';
  const indexPath = config.indexPath || 'index.md';
  const scanRoot = config.contentDir || '';
  const canonicalRoot = await realpath(root);
  const cacheKey = JSON.stringify([canonicalRoot, dailyDir, indexPath, scanRoot, config.excludes || [], config.projectDirs || [], projectFormat]);
  const reusable = previous?.cacheKey === cacheKey ? previous : null;
  const found = await markdownPaths(root, scanRoot, config, canonicalRoot);
  if (scanRoot) found.push(...await markdownPaths(root, dailyDir, config, canonicalRoot));
  const indexFile = await availableRepoFile(root, indexPath, config);
  if (indexFile) {
    const info = await stat(indexFile);
    found.push({ relative: indexPath, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  }
  const files = [...new Map(found.map(file => [file.relative, file])).values()]
    .sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const fileMeta = new Map(files.map(file => [file.relative, file]));
  const unchanged = relative => sameFile(reusable?.fileMeta?.get(relative), fileMeta.get(relative));
  const pages = await mapLimited(files, 32, async file => {
    if (unchanged(file.relative) && reusable?.byPath.has(file.relative)) return reusable.byPath.get(file.relative);
    return parsePage(file.relative, await readFile(path.join(root, file.relative), 'utf8'), config);
  });
  const baseDigests = new Map();
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (page.type !== 'project') continue;
    const digest = unchanged(page.path) && reusable?.baseDigests?.get(page.path) || projectDigest(page, projectFormat);
    baseDigests.set(page.path, digest);
    pages[index] = { ...page, digest: { ...digest } };
  }
  const weeklySummaries = pages.filter(page => page.type === 'insight' && includesHeading(page.id, projectFormat.weeklySummaryNames))
    .sort((a, b) => (b.attributes.updated || '').localeCompare(a.attributes.updated || ''))
    .map(page => ({ page, date: page.attributes.updated || page.attributes.created || '', sections: sectionsOf(page.body) }));
  const latestWeekly = weeklySummaries.find(item => item.sections.some(section => matchesHeading(section.title, projectFormat.weeklyPlanHeadings)));
  const weeklyPlanSection = latestWeekly?.sections.find(section => matchesHeading(section.title, projectFormat.weeklyPlanHeadings));
  const latestWeeklyPlan = weeklyPlanSection ? {
    path: latestWeekly.page.path,
    date: latestWeekly.date,
    heading: weeklyPlanSection.title,
    line: latestWeekly.page.bodyLineOffset + weeklyPlanSection.index + 1,
    items: firstUsefulLines(weeklyPlanSection.content, 5)
  } : null;
  const weeklyActions = weeklySummaries.flatMap(weekly => {
    const section = weekly.sections.find(item => matchesHeading(item.title, projectFormat.weeklyPlanHeadings));
    if (!section) return [];
    return section.content.split(/\r?\n/).flatMap((raw, index) => {
      const match = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.+)$/.exec(raw);
      if (!match) return [];
      const text = plainText(match[1]);
      if (!text || text.length > 180) return [];
      return [{ text, latest: weekly.page.path === latestWeekly?.page.path, evidence: {
        sourcePath: weekly.page.path,
        line: weekly.page.bodyLineOffset + section.index + index + 2,
        date: weekly.date, kind: 'weekly', heading: section.title
      } }];
    }).slice(0, 50);
  }).slice(0, 500);
  const normalized = text => text.toLocaleLowerCase().replace(/^project:\s*/, '').replace(/[\s_-]/g, '');
  for (const project of pages.filter(page => page.type === 'project')) {
    for (const weekly of weeklySummaries) {
      if (weekly.date < project.digest.progressDate) break;
      const section = weekly.sections.find(item => item.level >= 3 && [project.id, project.title].some(name => normalized(name) === normalized(item.title)));
      if (!section) continue;
      const evidence = sectionEvidence(section, weekly.page, weekly.date, 'weekly');
      if (!evidence.length) continue;
      project.digest.progress = evidence.map(item => item.text);
      project.digest.progressEvidence = evidence;
      project.digest.progressDate = weekly.date;
      project.digest.progressHeading = section.title;
      project.digest.progressSourcePath = weekly.page.path;
      project.digest.progressLine = weekly.page.bodyLineOffset + section.index + 1;
      break;
    }
  }
  const indexPage = pages.find(page => page.path === indexPath);
  const indexText = indexPage?.body || '';
  const indexDescriptions = new Map([...indexText.matchAll(/^- \[\[([^\]|#]+)(?:\|[^\]]+)?\]\]\s*[—–-]\s*(.+)$/gm)]
    .map(match => [match[1], {
      text: match[2].trim(), sourcePath: indexPath,
      line: (indexPage?.bodyLineOffset || 0) + indexText.slice(0, match.index).split('\n').length,
      date: indexPage?.attributes.updated || '', kind: 'index', heading: ''
    }]));
  for (const page of pages.filter(item => item.type === 'project')) {
    if (!page.digest.goal) {
      const evidence = indexDescriptions.get(page.id);
      page.digest.goal = evidence?.text || '';
      page.digest.goalEvidence = evidence || null;
    }
  }
  const indexedIds = new Set([...indexText.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(match => match[1]));
  const byPath = new Map(pages.map(page => [page.path, page]));
  const searchIndex = new Map(pages.map(page => [page.path, unchanged(page.path) && reusable?.searchIndex?.get(page.path) || {
    title: `${page.id} ${page.title}`.toLocaleLowerCase(),
    headings: page.headings.join(' ').toLocaleLowerCase(),
    body: page.body.toLocaleLowerCase()
  }]));
  const byId = new Map();
  const byAlias = new Map();
  for (const page of pages) {
    const matches = byId.get(page.id) || [];
    matches.push(page.path);
    byId.set(page.id, matches);
    for (const alias of page.attributes.aliases || []) {
      const aliasMatches = byAlias.get(alias) || [];
      aliasMatches.push(page.path);
      byAlias.set(alias, aliasMatches);
    }
  }
  const unindexed = indexText ? pages.filter(page => WIKI_TYPES.has(page.type) && !indexedIds.has(page.id)).map(page => ({ path: page.path, title: page.title })) : [];
  return { pages, byPath, byId, byAlias, unindexed, latestWeeklyPlan, weeklyActions, fileMeta, baseDigests, searchIndex, cacheKey };
}

export function searchLibrary(library, input, type = 'all', limit = 40) {
  const query = input.trim().toLocaleLowerCase();
  if (!query) return [];
  const terms = query.split(/\s+/).filter(Boolean);
  return library.pages.filter(page => type === 'all' || page.type === type)
    .map(page => {
      const { title, headings, body } = library.searchIndex?.get(page.path) || {
        title: `${page.id} ${page.title}`.toLocaleLowerCase(), headings: page.headings.join(' ').toLocaleLowerCase(), body: page.body.toLocaleLowerCase()
      };
      let score = 0;
      let hit = Infinity;
      for (const term of terms) {
        const inTitle = title.includes(term);
        const inHeading = headings.includes(term);
        const bodyPosition = body.indexOf(term);
        if (!inTitle && !inHeading && bodyPosition < 0) return null;
        score += (inTitle ? 12 : 0) + (inHeading ? 4 : 0) + (bodyPosition >= 0 ? 1 : 0);
        if (bodyPosition >= 0 && bodyPosition < hit) hit = bodyPosition;
      }
      if (hit === Infinity) hit = 0;
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

async function availableVaultFile(root, relative, config, maxBytes) {
  const safe = safeVaultPath(relative);
  if (!safe) return null;
  if (config.excludes?.some(excluded => safe === excluded || safe.startsWith(`${excluded}/`))) return null;
  const absolute = path.join(root, safe);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile() || info.size > maxBytes) return null;
  const canonical = await realpath(absolute).catch(() => null);
  const canonicalRoot = await realpath(root);
  if (!canonical?.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  return absolute;
}

export function availableRepoFile(root, relative, config = {}) {
  return availableVaultFile(root, relative, config, 3_000_000);
}

export function availableAssetFile(root, relative, config = {}) {
  if (typeof relative !== 'string' || !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(relative)) return Promise.resolve(null);
  return availableVaultFile(root, relative, config, 10_000_000);
}

export async function readAllowedFile(root, relative, config = {}) {
  const absolute = await availableRepoFile(root, relative, config);
  if (!absolute || !/\.(?:md|txt|json|jsonl|yaml|yml|py|csv|tsv)$/i.test(relative)) return null;
  return readFile(absolute, 'utf8');
}

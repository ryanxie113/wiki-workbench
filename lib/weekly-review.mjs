import { createHash } from 'node:crypto';
import { parseToday } from './daily.mjs';

function itemId(parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20); }

export function buildWeeklyReview(library, config, todayDate, actions, outcomes) {
  const dailyDir = config.dailyDir || 'daily';
  const start = new Date(`${todayDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 7);
  const startDate = start.toISOString().slice(0, 10);
  const unfinished = [];
  for (const page of library.pages) {
    if (page.type !== 'daily' || !page.path.startsWith(`${dailyDir}/`)) continue;
    const date = page.path.slice(dailyDir.length + 1).replace(/\.md$/i, '');
    if (date < startDate || date >= todayDate || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const parsed = parseToday(page.body, date, dailyDir, config.dailyFormat);
    for (const plan of parsed.plans.filter(item => item.text && !item.done)) {
      const target = /\[\[([^\]]+)\]\]$/.exec(plan.text)?.[1] || '';
      const projectPath = target ? (target.endsWith('.md') ? target : `${target}.md`) : '';
      const text = plan.text.replace(/\s*\[\[[^\]]+\]\]$/, '').trim();
      const action = actions.find(item => item.text === text && item.projectPath === projectPath);
      unfinished.push({ id: itemId([page.path, plan.priority, plan.text]), date, path: page.path, priority: plan.priority,
        text, projectPath, actionId: action?.id || '', evidence: { kind: 'daily', sourcePath: page.path, heading: config.dailyFormat?.planHeading || '', line: 0, date } });
    }
  }
  unfinished.sort((a, b) => b.date.localeCompare(a.date) || a.priority - b.priority);
  const deferred = actions.filter(item => {
    const history = outcomes.filter(event => event.id === item.id && event.adoption?.path === item.adoption?.path);
    return history.length >= 2 && history.filter(event => event.status === 'deferred').length >= 2 && history.at(-1)?.status === 'deferred';
  }).map(item => ({ id: itemId(['deferred', item.id, item.adoption?.path]), actionId: item.id, text: item.text,
    projectPath: item.projectPath || item.adoption?.projectPath || '', evidence: item.evidence,
    count: outcomes.filter(event => event.id === item.id && event.status === 'deferred').length }));
  const newPlans = (library.weeklyActions || []).filter(item => item.latest && item.evidence.date >= startDate)
    .map(item => ({ id: itemId(['weekly', item.evidence.sourcePath, item.evidence.line, item.text]), text: item.text,
      evidence: item.evidence, actionId: actions.find(candidate => candidate.evidence.kind === 'weekly' && candidate.text === item.text && candidate.evidence.sourcePath === item.evidence.sourcePath)?.id || '' }));
  return { startDate, endDate: todayDate, unfinished, deferred, newPlans };
}

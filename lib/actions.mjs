import { createHash } from 'node:crypto';
import { parseToday } from './daily.mjs';

export function actionId(projectPath, evidence, text, occurrence = 0) {
  const identity = JSON.stringify([projectPath, evidence?.sourcePath || '', evidence?.heading || '', text, occurrence]);
  return createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

export function buildActionInbox(library, config = {}, sourceActions = []) {
  const dailyDir = config.dailyDir || 'daily';
  const history = new Map();
  for (const page of library.pages) {
    if (page.type !== 'daily' || !page.path.startsWith(`${dailyDir}/`)) continue;
    const date = page.path.slice(dailyDir.length + 1).replace(/\.md$/i, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const parsed = parseToday(page.body, date, dailyDir, config.dailyFormat);
    for (const plan of parsed.plans) {
      if (!plan.text) continue;
      const entries = history.get(plan.text) || [];
      entries.push({ date, path: page.path, priority: plan.priority, done: plan.done });
      history.set(plan.text, entries);
    }
  }
  for (const entries of history.values()) entries.sort((a, b) => b.date.localeCompare(a.date));

  const candidates = library.pages.filter(page => page.type === 'project').flatMap(project => {
    const occurrences = new Map();
    return (project.digest?.action || []).flatMap((text, actionIndex) => {
      const evidence = project.digest.actionEvidence?.[actionIndex];
      if (!evidence || evidence.sourcePath !== project.path) return [];
      const identity = JSON.stringify([evidence.heading || '', text]);
      const occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      const linkedText = `${text} [[${project.path.replace(/\.md$/i, '')}]]`;
      return [{
        id: actionId(project.path, evidence, text, occurrence), projectPath: project.path,
        projectTitle: project.title, actionIndex, text, evidence,
        needsReview: Boolean(evidence.date && project.digest.progressDate && project.digest.progressDate > evidence.date),
        history: history.get(linkedText) || []
      }];
    });
  });

  const projectCandidates = [...candidates];
  const weeklyOccurrences = new Map();
  for (const [index, weekly] of (library.weeklyActions || []).entries()) {
    const identity = `${weekly.evidence.sourcePath}\u0000${weekly.text}`;
    const occurrence = weeklyOccurrences.get(identity) || 0;
    weeklyOccurrences.set(identity, occurrence + 1);
    const matchingPlans = [...history.entries()].filter(([text]) => text.startsWith(`${weekly.text} [[`))
      .flatMap(([text, entries]) => {
        const target = /\[\[([^\]]+)\]\]$/.exec(text)?.[1];
        return target ? entries.map(entry => ({ ...entry, projectPath: target.endsWith('.md') ? target : `${target}.md` })) : [];
      })
      .filter(entry => entry.date >= weekly.evidence.date && !(library.weeklyActions || []).some(other => other !== weekly && other.text === weekly.text
        && other.evidence.date > weekly.evidence.date && other.evidence.date <= entry.date));
    matchingPlans.sort((a, b) => b.date.localeCompare(a.date));
    if (!weekly.latest && matchingPlans.length === 0) continue;
    const competingProject = projectCandidates.some(project => project.text === weekly.text && matchingPlans.some(entry => entry.projectPath === project.projectPath));
    const ambiguous = competingProject || new Set(matchingPlans.map(entry => entry.projectPath)).size > 1;
    candidates.push({
      id: actionId('', weekly.evidence, weekly.text, occurrence), projectPath: null,
      projectTitle: '周报计划 · 未关联项目', actionIndex: index, text: weekly.text,
      evidence: weekly.evidence, needsReview: false, ambiguous, history: matchingPlans
    });
  }

  for (const proposal of sourceActions) {
    const project = library.byPath.get(proposal.projectPath);
    if (!project || project.type !== 'project' || !/^https?:\/\//i.test(proposal.url)) continue;
    const evidence = { kind: 'external', sourcePath: proposal.url, url: proposal.url, heading: '', line: 0,
      date: /^\d{4}-\d{2}-\d{2}/.test(proposal.createdAt) ? proposal.createdAt.slice(0, 10) : '', title: proposal.title || proposal.url };
    const linkedText = `${proposal.text} [[${project.path.replace(/\.md$/i, '')}]]`;
    candidates.push({ id: actionId(project.path, evidence, proposal.text), projectPath: project.path,
      projectTitle: project.title, actionIndex: -1, text: proposal.text, evidence, needsReview: false,
      history: history.get(linkedText) || [] });
  }

  const duplicates = new Map();
  for (const item of candidates) {
    const key = `${item.projectPath}\u0000${item.text}`;
    duplicates.set(key, (duplicates.get(key) || 0) + 1);
  }
  return candidates.map(item => {
    const ambiguous = item.ambiguous || (item.projectPath ? duplicates.get(`${item.projectPath}\u0000${item.text}`) > 1 : false);
    const adoption = !ambiguous ? item.history[0] || null : null;
    const { history: _history, ...candidate } = item;
    return { ...candidate, ambiguous, adoption, status: adoption ? adoption.done ? 'completed' : 'planned' : 'pending' };
  }).sort((a, b) => (b.evidence.date || '').localeCompare(a.evidence.date || '') || a.projectTitle.localeCompare(b.projectTitle));
}

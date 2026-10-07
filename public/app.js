const PROJECT_BATCH_SIZE = 60;
const ACTION_BATCH_SIZE = 60;
const CAPTURE_OPTION_LIMIT = 50;
const INBOX_BATCH_SIZE = 40;
const X_SUGGESTIONS = [
  { handle: 'simonw', name: 'Simon Willison', topic: 'AI 工程', why: 'LLM 工具、Agent 实践与安全' },
  { handle: 'karpathy', name: 'Andrej Karpathy', topic: 'AI 研究', why: '模型训练、AI 教育与软件开发' },
  { handle: 'addyosmani', name: 'Addy Osmani', topic: 'Web 开发', why: '前端性能、开发工具与 AI 编程' },
  { handle: 'rauchg', name: 'Guillermo Rauch', topic: 'Web 平台', why: '现代 Web、开发体验与 AI 产品' },
  { handle: 'mitchellh', name: 'Mitchell Hashimoto', topic: '开发工具', why: '开源工具、终端与基础设施' },
  { handle: 'GergelyOrosz', name: 'Gergely Orosz', topic: '软件工程', why: '工程团队、行业观察与实践' }
];
const X_STORAGE_KEY = 'wiki-workbench-x-subscriptions';
const state = { data: null, route: '', searchRequest: 0, projectFilter: '', projectVisible: PROJECT_BATCH_SIZE, actionFilter: '', actionVisible: ACTION_BATCH_SIZE, reviewChoices: null, weeklyDecisions: {}, workspaceSave: Promise.resolve(),
  connection: { path: '', contentDir: '', dailyDir: 'daily', writeDaily: false, preview: null, error: '', busy: false },
  inbox: { vaultId: '', feeds: [], manual: [], decisions: {}, sourceActions: [], results: new Map(), errors: new Map(), aihot: null, aihotError: '', loading: false, loaded: false, visible: INBOX_BATCH_SIZE },
  aihot: { subscribed: false, reports: new Map(), index: null, indexError: '', indexLoading: false, loading: new Set(), error: '', errorKey: '', nextAutoAt: 0 },
  x: { subscribed: new Set(X_SUGGESTIONS.map(item => item.handle.toLowerCase())), custom: [], selected: 'simonw', embedLoaded: false, embedFailed: false } };
const main = document.querySelector('#main');
const toast = document.querySelector('#toast');

const typeLabels = { project: '项目', concept: '概念', entity: '实体', source: '资料', insight: '洞察', personal: '个人', daily: '日报', index: '索引', other: '笔记' };
const pageHref = (path, heading = '', line = 0) => {
  const params = new URLSearchParams();
  if (heading) params.set('heading', heading);
  if (line) params.set('line', String(line));
  return `#/page/${encodeURIComponent(path)}${params.size ? `?${params}` : ''}`;
};
const projectHref = path => `#/project/${encodeURIComponent(path)}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const escapeAttr = escapeHtml;
try { state.aihot.subscribed = localStorage.getItem('wiki-workbench-aihot-subscription') === '1'; } catch {}
function xHandle(value) {
  const input = String(value ?? '').trim();
  const match = input.match(/^(?:@)?([A-Za-z0-9_]{1,15})$/)
    || input.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/?$/i);
  return match ? match[1].toLowerCase() : '';
}
try {
  const saved = JSON.parse(localStorage.getItem(X_STORAGE_KEY) || 'null');
  if (saved && Array.isArray(saved.custom) && Array.isArray(saved.handles)) {
    const suggested = new Set(X_SUGGESTIONS.map(item => item.handle.toLowerCase()));
    state.x.custom = [...new Set(saved.custom.map(xHandle).filter(handle => handle && !suggested.has(handle)))].slice(0, 30);
    const available = new Set([...suggested, ...state.x.custom]);
    state.x.subscribed = new Set(saved.handles.map(xHandle).filter(handle => available.has(handle)));
    state.x.selected = [...state.x.subscribed][0] || 'simonw';
  }
} catch {}
const formatDate = value => value ? value.replaceAll('-', '.') : '日期未记录';
const priorities = () => state.data.dailyFormat.priorityLabels.map((label, index) => ({ label, priority: index + 1 }));
const headingSlug = value => String(value || '').toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const evidenceTypes = { project: '项目页', weekly: '周报', index: '索引', external: '外部来源', daily: '日报' };
const evidenceLabel = evidence => evidence.kind === 'external' ? `外部来源 · ${evidence.title || evidence.sourcePath} · ${formatDate(evidence.date)}` : `${evidenceTypes[evidence.kind] || '原文'} · ${evidence.sourcePath}:${evidence.line} · ${formatDate(evidence.date)}`;
const evidenceLink = evidence => evidence
  ? evidence.kind === 'external' ? safeExternalLink(evidence.url, evidenceLabel(evidence), 'evidence-link') : `<a class="evidence-link" href="${pageHref(evidence.sourcePath, evidence.heading, evidence.line)}">${escapeHtml(evidenceLabel(evidence))} ↗</a>`
  : '<span class="missing-evidence">来源未定位，请打开原文核对</span>';

function notice(message, error = false) {
  toast.textContent = message;
  toast.className = error ? 'visible error' : 'visible';
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { toast.className = ''; }, 3800);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function refresh(force = false) {
  state.data = await api(force ? '/api/bootstrap?refresh=1' : '/api/bootstrap');
  if (state.inbox.vaultId !== state.data.vault.id) loadInboxSettings();
  const saved = state.data.workspaceState?.data;
  if (saved) {
    state.inbox.feeds = saved.inbox?.feeds || [];
    state.inbox.manual = saved.inbox?.manual || [];
    state.inbox.decisions = saved.inbox?.decisions || {};
    state.inbox.sourceActions = saved.inbox?.sourceActions || [];
    state.reviewChoices = saved.reviewChoices || {};
    state.weeklyDecisions = saved.weeklyDecisions || {};
    if (saved.aihot) state.aihot.subscribed = saved.aihot.subscribed;
    if (saved.x) applyXSubscriptions(saved.x);
  } else {
    state.reviewChoices = null;
    state.weeklyDecisions = {};
    if (state.data.workspaceState === null) {
      void saveWorkspaceSections({ inbox: inboxSnapshot(), reviewChoices: reviewChoices(), weeklyDecisions: {},
        aihot: { subscribed: state.aihot.subscribed }, x: xSnapshot() }, true);
    }
  }
  document.querySelector('#top-date').textContent = state.data.today.date.replaceAll('-', ' / ');
  const overview = document.querySelector('#nav-overview');
  overview.hidden = !state.data.overviewPath;
  if (state.data.overviewPath) overview.href = pageHref(state.data.overviewPath);
  const index = document.querySelector('#side-index');
  index.hidden = !state.data.indexPath;
  if (state.data.indexPath) index.href = pageHref(state.data.indexPath);
  document.querySelector('#vault-status').textContent = state.data.dailyWritable ? '日报写入已启用' : '默认只读';
  document.querySelector('#vault-name').textContent = state.data.vault.demo ? '正在浏览示例资料库' : '已连接本地资料库';
  document.querySelector('#vault-path').textContent = state.data.vault.path;
}

function inboxStorageKey() { return `wiki-workbench-inbox:${state.data.vault.id}`; }
function loadInboxSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(inboxStorageKey()) || 'null'); } catch {}
  state.inbox = {
    vaultId: state.data.vault.id,
    feeds: Array.isArray(saved?.feeds) ? saved.feeds.filter(item => typeof item === 'string').slice(0, 30) : [],
    manual: Array.isArray(saved?.manual) ? saved.manual.filter(item => item && typeof item.url === 'string').slice(0, 100) : [],
    decisions: saved?.decisions && typeof saved.decisions === 'object' && !Array.isArray(saved.decisions) ? saved.decisions : {},
    sourceActions: Array.isArray(saved?.sourceActions) ? saved.sourceActions : [],
    results: new Map(), errors: new Map(), aihot: null, aihotError: '', loading: false, loaded: false, visible: INBOX_BATCH_SIZE
  };
}
function saveInboxSettings() {
  const snapshot = inboxSnapshot();
  try { localStorage.setItem(inboxStorageKey(), JSON.stringify(snapshot)); } catch {}
  return saveWorkspaceSection('inbox', snapshot);
}
function inboxSnapshot() { return { feeds: state.inbox.feeds, manual: state.inbox.manual,
  decisions: Object.fromEntries(Object.entries(state.inbox.decisions).slice(-500)), sourceActions: state.inbox.sourceActions }; }
function xSnapshot() { return { handles: [...state.x.subscribed], custom: state.x.custom }; }
function applyXSubscriptions(saved) {
  const suggested = new Set(X_SUGGESTIONS.map(item => item.handle.toLowerCase()));
  state.x.custom = [...new Set((saved.custom || []).map(xHandle).filter(handle => handle && !suggested.has(handle)))].slice(0, 30);
  const available = new Set([...suggested, ...state.x.custom]);
  state.x.subscribed = new Set((saved.handles || []).map(xHandle).filter(handle => available.has(handle)));
  state.x.selected = [...state.x.subscribed][0] || 'simonw';
}
function saveWorkspaceSections(data, replace = false, actionOutcomes) {
  if (state.data?.workspaceState === undefined) return Promise.resolve();
  const vaultId = state.data.vault.id;
  const task = state.workspaceSave.then(async () => {
    if (state.data?.vault.id !== vaultId) return;
    const payload = replace ? { import: true, version: 1, data, actionOutcomes } : null;
    if (payload) {
      const result = await api('/api/workspace-state', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify(payload) });
      state.data.workspaceState = result.workspaceState;
    } else {
      for (const [section, value] of Object.entries(data)) {
        const result = await api('/api/workspace-state', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ section, value }) });
        state.data.workspaceState = result.workspaceState;
      }
    }
  });
  state.workspaceSave = task.catch(error => { notice(`本机状态保存失败：${error.message}`, true); });
  return task;
}
function saveWorkspaceSection(section, value) { return saveWorkspaceSections({ [section]: value }); }

function reviewStorageKey() { return `wiki-workbench-review:${state.data.vault.id}`; }
function reviewChoices() {
  if (state.reviewChoices) return state.reviewChoices;
  try {
    const saved = JSON.parse(localStorage.getItem(reviewStorageKey()) || '{}');
    state.reviewChoices = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }
  catch { state.reviewChoices = {}; }
  return state.reviewChoices;
}
function actionStatus(item) {
  const result = actionOutcome(item);
  if (result && item.adoption && item.status === 'planned') return result.status;
  if (item.status !== 'pending') return item.status;
  const choice = reviewChoices()[item.id];
  return choice === 'deferred' || choice === 'ignored' ? choice : 'pending';
}
function actionOutcome(item) {
  return (state.data.actionOutcomes || []).findLast(event => event.id === item.id
    && event.adoption?.path === item.adoption?.path && event.adoption?.date === item.adoption?.date) || null;
}
function actionOutcomeHistory(item) {
  return (state.data.actionOutcomes || []).filter(event => event.id === item.id
    && event.adoption?.path === item.adoption?.path && event.adoption?.date === item.adoption?.date);
}
function actionConflict(item) {
  const outcome = actionOutcome(item);
  if (!outcome || !item.adoption) return false;
  if (item.adoption.done) return outcome.status !== 'completed';
  return outcome.status === 'completed' && item.adoption.date === state.data.today.date;
}
function canSyncDaily(item) {
  return Boolean(state.data.dailyWritable && item.adoption && !item.adoption.done
    && item.adoption.date === state.data.today.date && item.adoption.path === state.data.today.path);
}
const actionLabels = { pending: '待判断', deferred: '已延期', ignored: '已忽略', planned: '已采纳', completed: '已完成', invalidated: '已失效' };
function vaultBanner() {
  const { vault, dailyWritable } = state.data;
  return `<section class="vault-banner ${vault.demo ? 'is-demo' : ''}"><div><span class="eyebrow">${vault.demo ? 'DEMO LIBRARY' : 'CONNECTED LIBRARY'}</span><strong>${vault.demo ? '当前展示虚构示例，尚未连接你的 Wiki' : '当前读取你的本地资料库'}</strong><code>${escapeHtml(vault.path)}</code><small>${vault.pageCount} 篇 Markdown · ${dailyWritable ? `仅 ${escapeHtml(state.data.dailyDir)}/ 日报可写` : '只读，不会修改资料'}</small></div><a href="#/vault">${vault.demo ? '查看连接方式' : '查看资料库详情'} ↗</a></section>`;
}

function sectionHeader(eyebrow, title, description = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div></div>`;
}

function projectCard(project, compact = false) {
  const digest = project.digest;
  const summary = digest.goal || digest.progress[0] || '打开项目查看详细记录';
  return `<a class="project-card ${compact ? 'compact' : ''}" href="${projectHref(project.path)}"><div class="card-top"><span class="type-pill">项目</span><span class="card-date">记录至 ${formatDate(digest.progressDate || project.date)}</span></div><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(summary)}</p><div class="card-bottom"><span>${digest.action.length ? '有后续记录' : '查看进展'}</span><span class="arrow">↗</span></div></a>`;
}

function matchingProjects(query) {
  const term = query.trim().toLocaleLowerCase();
  return term ? state.data.projects.filter(project => `${project.title} ${project.id} ${project.path}`.toLocaleLowerCase().includes(term)) : state.data.projects;
}

function captureProjectOptions(query = '') {
  return matchingProjects(query).slice(0, CAPTURE_OPTION_LIMIT).map(project =>
    `<option value="${escapeAttr(project.path)}">${escapeHtml(project.title)} · ${escapeHtml(project.path)}</option>`).join('');
}

function candidateRow(item) {
  const status = actionStatus(item);
  const adoption = item.adoption ? `<a class="action-outcome" href="${pageHref(item.adoption.path)}">日报采纳 · ${formatDate(item.adoption.date)} · ${escapeHtml(item.adoption.path)} ↗</a>` : '';
  const outcome = actionOutcome(item);
  const outcomeHistory = outcome && item.adoption ? actionOutcomeHistory(item) : [];
  const outcomeHtml = outcome ? `<div class="action-outcome">结果记录 · ${actionLabels[outcome.status]} · ${escapeHtml(new Date(outcome.at).toLocaleString('zh-CN'))}${outcome.note ? ` · ${escapeHtml(outcome.note)}` : ''}</div>${outcomeHistory.length > 1 ? `<details class="action-history"><summary>查看 ${outcomeHistory.length} 条处理记录</summary><ol>${outcomeHistory.map(event => `<li>${escapeHtml(new Date(event.at).toLocaleString('zh-CN'))} · ${escapeHtml(actionLabels[event.status])}${event.note ? ` · ${escapeHtml(event.note)}` : ''}</li>`).join('')}</ol></details>` : ''}` : '';
  const conflict = actionConflict(item);
  const conflictHtml = conflict ? `<div class="action-conflict">状态不一致：工作台记录为${outcome.status === 'completed' ? '已完成' : actionLabels[outcome.status]}，日报计划${item.adoption.done ? '已勾选' : '未勾选'}。请核对后校准。</div>` : '';
  const isOldWeekly = item.evidence.kind === 'weekly' && Date.parse(`${item.evidence.date}T00:00:00Z`) < Date.parse(`${state.data.today.date}T00:00:00Z`) - 14 * 86400000;
  const warning = item.needsReview ? '<span class="action-warning">原文后有更新的进展，请复核</span>' : isOldWeekly ? '<span class="action-warning">这份周报已超过两周，请确认计划仍有效</span>' : '';
  const ambiguity = item.ambiguous ? '<span class="action-warning">存在同文事项，无法可靠匹配日报；请先核对原文</span>' : '';
  const planButtons = status === 'pending' && !item.ambiguous && state.data.dailyWritable && state.data.today.exists
    ? `${item.projectPath ? '' : `<select class="action-project" aria-label="选择关联项目"><option value="">选择关联项目</option>${captureProjectOptions()}</select>`}${priorities().map(({ priority, label }) => `<button type="button" data-action="plan" data-id="${item.id}" data-priority="${priority}">采纳为 ${escapeHtml(label)}</button>`).join('')}` : '';
  const reviewButtons = !item.adoption && status === 'pending' ? `<button type="button" data-action="review" data-id="${item.id}" data-choice="deferred">暂缓</button><button type="button" data-action="review" data-id="${item.id}" data-choice="ignored">忽略</button>`
    : !item.adoption && ['deferred', 'ignored'].includes(status) ? `<button type="button" data-action="review" data-id="${item.id}" data-choice="pending">恢复待判断</button>` : '';
  const outcomeButtons = item.adoption && item.status === 'planned' && !conflict ? (status === 'planned'
    ? `${canSyncDaily(item) ? `<button type="button" data-action="outcome" data-id="${item.id}" data-status="completed" data-sync-daily="1">完成并勾选日报</button>` : ''}<button type="button" data-action="outcome" data-id="${item.id}" data-status="completed">${canSyncDaily(item) ? '仅记录完成' : '记录完成'}</button><button type="button" data-action="outcome" data-id="${item.id}" data-status="deferred">延期</button><button type="button" data-action="outcome" data-id="${item.id}" data-status="invalidated">失效</button>`
    : `<button type="button" data-action="outcome" data-id="${item.id}" data-status="planned">恢复已采纳</button>`) : '';
  const conflictButtons = conflict ? `<button type="button" data-action="resolve-outcome" data-id="${item.id}">以日报为准</button>${canSyncDaily(item) && outcome.status === 'completed' ? `<button type="button" data-action="outcome" data-id="${item.id}" data-status="completed" data-sync-daily="1">同步勾选今日日报</button>` : ''}` : '';
  const projectLink = item.projectPath || item.adoption?.projectPath;
  return `<div class="candidate-row"><div class="candidate-icon">↗</div><div class="candidate-body"><div class="action-title-line">${projectLink ? `<a class="candidate-title" href="${projectHref(projectLink)}">${escapeHtml(item.projectTitle === '周报计划 · 未关联项目' ? state.data.projects.find(project => project.path === projectLink)?.title || item.projectTitle : item.projectTitle)}</a>` : `<span class="candidate-title">${escapeHtml(item.projectTitle)}</span>`}<span class="action-status status-${status}">${status === 'deferred' && !item.adoption ? '已暂缓' : actionLabels[status]}</span></div><p>${escapeHtml(item.text)}</p>${evidenceLink(item.evidence)}${warning}${ambiguity}${adoption}${outcomeHtml}${conflictHtml}</div><div class="candidate-actions">${planButtons}${reviewButtons}${outcomeButtons}${conflictButtons}${item.evidence.kind === 'external' && !item.adoption ? `<button type="button" data-action="remove-source-action" data-id="${item.id}">移除建议</button>` : ''}</div></div>`;
}

function renderToday() {
  const { today, projects, pageCounts, unindexed } = state.data;
  if (!state.data.dailyWritable) {
    const indexReview = state.data.indexPath ? `<i></i><a href="#/unindexed"><strong>${unindexed.length}</strong> 篇未列入索引 ↗</a>` : '';
    const candidates = state.data.actions.filter(item => actionStatus(item) === 'pending').slice(0, 4);
    main.innerHTML = `${sectionHeader('YOUR LIBRARY', '从已有 Wiki 看清项目进展', '查看带日期的摘要，打开原文核对依据。当前以只读模式运行。')}
      ${vaultBanner()}
      <div class="overview-strip"><span><strong>${projects.length}</strong> 个项目页面</span><i></i><span><strong>${Object.values(pageCounts).reduce((a, b) => a + b, 0)}</strong> 篇 Markdown 页面</span>${indexReview}</div>
      <section class="section-block"><div class="section-title"><div><span class="eyebrow">PROJECTS</span><h2>项目记录</h2><p>摘要提供原文入口；核对后再决定今天要做什么。</p></div><a href="#/projects">浏览全部项目 ↗</a></div><div class="project-grid">${projects.length ? projects.slice(0, 6).map(project => projectCard(project, true)).join('') : '<div class="empty-inline">如需项目视图，请在页面 frontmatter 中设置 type: project，或放入 projects/ 目录。</div>'}</div></section>
      <section class="section-block"><div class="section-title"><div><span class="eyebrow">REVIEW</span><h2>待审阅的后续事项</h2><p>来自项目原文，先核对日期与上下文。</p></div><a href="#/actions">查看全部 ↗</a></div><div class="candidate-list">${candidates.length ? candidates.map(candidateRow).join('') : '<div class="empty-inline">目前没有待判断的后续事项。</div>'}</div></section>
      <section class="section-block"><div class="section-title"><div><span class="eyebrow">RECENT NOTES</span><h2>最近的笔记</h2></div><a href="#/search">搜索全部内容 ↗</a></div><div class="recent-grid">${state.data.recent.slice(0, 8).map(page => `<a class="recent-card" href="${pageHref(page.path)}"><span class="type-pill">${typeLabels[page.type] || '页面'}</span><h3>${escapeHtml(page.title)}</h3><small>${formatDate(page.date)}</small><span class="arrow">↗</span></a>`).join('') || '<div class="empty-inline">资料库中还没有 Markdown 页面。</div>'}</div></section>`;
    return;
  }
  const weeklyPlan = state.data.latestWeeklyPlan;
  const plans = priorities().map(({ priority, label }) => {
    const plan = today.plans.find(item => item.priority === priority);
    return `<div class="plan-row"><span class="priority">${escapeHtml(label)}</span><span class="plan-text ${plan?.text ? '' : 'muted'}">${plan?.text ? escapeHtml(plan.text) : '尚未安排，选取下方项目记录后加入'}</span>${plan?.text ? `<span class="plan-mark">${plan.done ? '已完成' : '已安排'}</span>` : ''}</div>`;
  }).join('');
  const candidates = state.data.actions.filter(item => actionStatus(item) === 'pending').slice(0, 5);
  const records = today.records.length ? today.records.slice(-4).reverse().map(record => `<div class="record-row"><span>${escapeHtml(record.time)}</span><p>${escapeHtml(record.text)}</p><small>${escapeHtml(record.tag)}</small></div>`).join('') : '<div class="empty-inline">暂无记录。开始工作后可随手记下一条进展。</div>';
  main.innerHTML = `${sectionHeader('YOUR WORKSPACE', '从已有记录安排今天', '先打开依据核对，再手动采纳后续事项，并把实际进展记入日报。')}
    ${vaultBanner()}
    <div class="overview-strip"><span><strong>${projects.length}</strong> 个项目页面</span><i></i><span><strong>${Object.values(pageCounts).reduce((a, b) => a + b, 0)}</strong> 篇 Wiki 页面</span><i></i><a href="#/unindexed"><strong>${unindexed.length}</strong> 篇尚未纳入根索引 ↗</a></div>
    <div class="today-grid"><section class="panel plan-panel"><div class="panel-title"><div><span class="eyebrow">01 / FOCUS</span><h2>${escapeHtml(state.data.dailyFormat.planHeading)}</h2></div><span class="panel-date">${formatDate(today.date)}</span></div>${today.exists ? `<div class="plan-list">${plans}</div><a class="text-link" href="${pageHref(today.path)}">查看今日日报 ↗</a>` : `<div class="empty-plan"><div class="empty-icon">◌</div><h3>今天还没有日报</h3><p>从现有模板建立空白日报，然后手动选取任务。</p><button class="primary-button" data-action="init">初始化今日日报 <span>↗</span></button></div>`}</section>
    <section class="panel capture-panel"><div class="panel-title"><div><span class="eyebrow">02 / CAPTURE</span><h2>随手记录</h2></div><span class="small-badge">写入 ${escapeHtml(state.data.dailyDir)}/</span></div><form id="capture-form"><label for="capture-text">今天推进了什么？</label><textarea id="capture-text" name="text" maxlength="400" placeholder="一句话记录具体进展或卡点…" ${today.exists ? '' : 'disabled'} required></textarea><input id="capture-project-filter" class="capture-project-filter" type="search" placeholder="输入项目名称或路径查找…" aria-label="筛选关联项目" ${today.exists ? '' : 'disabled'} /><div class="form-row"><select id="capture-project-list" name="projectPath" aria-label="关联项目" ${today.exists ? '' : 'disabled'} required><option value="">选择关联项目（最多显示 50 项）</option>${captureProjectOptions()}</select><button type="submit" ${today.exists ? '' : 'disabled'}>记录 ↗</button></div></form><div class="recent-records"><span class="mini-label">${escapeHtml(state.data.dailyFormat.timelineHeading)}</span>${records}</div></section></div>
    ${weeklyPlan ? `<section class="section-block"><div class="section-title"><div><span class="eyebrow">LATEST WEEKLY NOTE</span><h2>最近周报的下周计划</h2><p>记录于 ${formatDate(weeklyPlan.date)}，仅作回看与核对。</p></div><a href="${pageHref(weeklyPlan.path, weeklyPlan.heading, weeklyPlan.line)}">查看周报原文 ↗</a></div><div class="weekly-plan">${weeklyPlan.items.map((item, index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(item)}</p></div>`).join('')}</div></section>` : ''}
    <section class="section-block"><div class="section-title"><div><span class="eyebrow">FROM YOUR PROJECT NOTES</span><h2>待审阅的后续事项</h2><p>部分记录早于最近周报。请核对日期，再决定是否加入今天。</p></div><a href="#/actions">查看全部 ↗</a></div><div class="candidate-list">${candidates.length ? candidates.map(candidateRow).join('') : '<div class="empty-inline">目前没有待判断的后续事项。</div>'}</div></section>
    <section class="section-block"><div class="section-title"><div><span class="eyebrow">QUICK ACCESS</span><h2>最近的知识记录</h2></div><a href="#/search">搜索全部内容 ↗</a></div><div class="recent-grid">${state.data.recent.slice(0, 4).map(page => `<a class="recent-card" href="${pageHref(page.path)}"><span class="type-pill">${typeLabels[page.type] || '页面'}</span><h3>${escapeHtml(page.title)}</h3><small>${formatDate(page.date)}</small><span class="arrow">↗</span></a>`).join('')}</div></section>`;
}

function renderActions() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const filter = ['pending', 'planned', 'completed', 'deferred', 'invalidated', 'ignored', 'all'].includes(params.get('filter')) ? params.get('filter') : 'pending';
  if (filter !== state.actionFilter) { state.actionFilter = filter; state.actionVisible = ACTION_BATCH_SIZE; }
  const actions = state.data.actions;
  const counts = Object.fromEntries(['pending', 'planned', 'completed', 'deferred', 'invalidated', 'ignored'].map(status => [status, actions.filter(item => actionStatus(item) === status).length]));
  const shown = filter === 'all' ? actions : actions.filter(item => actionStatus(item) === filter);
  const visible = shown.slice(0, state.actionVisible);
  main.innerHTML = `${sectionHeader('ACTION REVIEW', '从记录到行动', '每条候选项都附有原文、行号和日期；旧记录需要再次核对。')}
    ${vaultBanner()}
    <div class="action-toolbar"><button type="button" data-action="refresh-actions">重新读取日报与结果 ↻</button></div>
    <div class="action-tabs">${['pending', 'planned', 'completed', 'deferred', 'invalidated', 'ignored', 'all'].map(status => `<a class="filter-chip ${filter === status ? 'active' : ''}" href="#/actions?filter=${status}">${status === 'all' ? '全部' : status === 'deferred' ? '暂缓 / 延期' : actionLabels[status]} <strong>${status === 'all' ? actions.length : counts[status]}</strong></a>`).join('')}</div>
    <p class="review-hint">采纳状态从日报读取；结果和审阅记录按资料库保存在本机。选择“完成并勾选日报”时，仅会在确认后更新当日对应计划；状态不一致会提示校准。${state.data.dailyWritable ? '' : '当前只读，<a href="#/vault">查看如何启用日报采纳 ↗</a>'}</p>
    <div class="candidate-list">${visible.length ? visible.map(candidateRow).join('') : '<div class="empty-inline">这一类目前没有事项。</div>'}</div>${visible.length < shown.length ? `<button type="button" class="project-more" data-action="action-more">显示更多（剩余 ${shown.length - visible.length} 项）</button>` : ''}`;
}

function safeExternalLink(url, label, className = '') {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `<a class="${className}" href="${escapeAttr(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`;
  } catch { return ''; }
}

function aihotItem(item, compact = false) {
  const source = item.source ? `<span>${escapeHtml(item.source)}</span>` : '';
  const links = `${safeExternalLink(item.links?.aihot, 'AIHOT 详情')}${safeExternalLink(item.links?.original, '原始来源')}`;
  return `<article class="aihot-item ${compact ? 'is-flash' : ''}"><h3>${escapeHtml(item.title)}</h3>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}<div class="aihot-item-meta">${source}${links}</div></article>`;
}

function beijingDate(timestamp = Date.now()) { return new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10); }

function nextAihotCheck(reportDate, timestamp = Date.now()) {
  const today = beijingDate(timestamp);
  const releaseTime = Date.parse(`${today}T00:05:00Z`);
  if (reportDate === today) return releaseTime + 24 * 60 * 60_000;
  return timestamp < releaseTime ? releaseTime : timestamp + 30 * 60_000;
}

function aihotSelectedDate() {
  const value = new URLSearchParams(location.hash.split('?')[1] || '').get('date') || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

async function loadAihotIndex(force = false) {
  if (state.aihot.indexLoading) return;
  state.aihot.indexLoading = true;
  try {
    const result = await api(`/api/aihot/dailies${force ? '?refresh=1' : ''}`);
    state.aihot.index = result.items;
    state.aihot.indexError = '';
  } catch (error) { state.aihot.indexError = error.message; }
  state.aihot.indexLoading = false;
  if (location.hash.startsWith('#/aihot')) renderAihot();
}

async function loadAihotDaily(date = '', force = false) {
  const key = date || 'latest';
  if (state.aihot.loading.has(key)) return;
  state.aihot.loading.add(key);
  state.aihot.error = '';
  state.aihot.errorKey = '';
  if (location.hash.startsWith('#/aihot')) renderAihot();
  try {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (force) params.set('refresh', '1');
    const result = await api(`/api/aihot/daily${params.size ? `?${params}` : ''}`);
    state.aihot.reports.set(key, result);
    if (key === 'latest') state.aihot.nextAutoAt = nextAihotCheck(result.report.date);
  } catch (error) {
    state.aihot.error = error.message;
    state.aihot.errorKey = key;
    if (state.aihot.reports.has(key)) state.aihot.reports.get(key).stale = true;
    if (key === 'latest') state.aihot.nextAutoAt = Date.now() + 30 * 60_000;
  } finally {
    state.aihot.loading.delete(key);
    if (location.hash.startsWith('#/aihot')) renderAihot();
  }
}

async function checkAihotSubscription() {
  if (!state.aihot.subscribed || Date.now() < state.aihot.nextAutoAt || state.aihot.loading.has('latest')) return;
  const previousDate = state.aihot.reports.get('latest')?.report.date;
  state.aihot.nextAutoAt = Date.now() + 30 * 60_000;
  await loadAihotDaily('', true);
  const latestDate = state.aihot.reports.get('latest')?.report.date;
  if (previousDate && latestDate && latestDate !== previousDate) notice(`AI 行业日报已更新：${formatDate(latestDate)}`);
}

function renderAihot() {
  const date = aihotSelectedDate();
  const key = date || 'latest';
  const result = state.aihot.reports.get(key);
  const currentError = state.aihot.errorKey === key ? state.aihot.error : '';
  const report = result?.report;
  const syncStatus = state.aihot.loading.has(key) ? '正在同步…' : result?.fetchedAt
    ? `上次同步：${new Date(result.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : '';
  const archive = state.aihot.index || [];
  const dateOptions = archive.map(item => `<option value="${escapeAttr(item.date)}" ${date === item.date ? 'selected' : ''}>${formatDate(item.date)} · ${escapeHtml(item.title || 'AI 日报')}</option>`).join('');
  const header = `${sectionHeader('AI DAILY BRIEF', 'AI 行业日报', '从 AIHOT 获取精编日报，保留站内详情与原始信源入口。')}
    <section class="panel aihot-controls"><div><strong>${state.aihot.subscribed ? '已订阅每日更新' : '按需获取日报'}</strong><p>订阅后，工作台开启期间每天北京时间 08:05 后检查新一期；不写入 Wiki。</p></div><div class="aihot-buttons"><button type="button" data-action="aihot-subscribe" aria-pressed="${state.aihot.subscribed}">${state.aihot.subscribed ? '取消订阅' : '订阅每日更新'}</button><button type="button" data-action="aihot-refresh">重新获取</button></div></section>
    <div class="aihot-toolbar"><label for="aihot-date">选择期数</label><select id="aihot-date"><option value="" ${date ? '' : 'selected'}>最新一期</option>${date && !archive.some(item => item.date === date) ? `<option value="${escapeAttr(date)}" selected>${formatDate(date)}</option>` : ''}${dateOptions}</select>${syncStatus ? `<small>${escapeHtml(syncStatus)}</small>` : ''}${state.aihot.indexError ? `<small>往期索引暂不可用：${escapeHtml(state.aihot.indexError)}</small>` : ''}</div>`;
  if (!report) {
    main.innerHTML = `${header}<div class="${currentError ? 'error-state' : 'loading-state'}">${escapeHtml(currentError || '正在获取 AIHOT 日报…')}</div>`;
    if (!currentError && !state.aihot.loading.has(key)) void loadAihotDaily(date);
    if (!state.aihot.index && !state.aihot.indexError && !state.aihot.indexLoading) void loadAihotIndex();
    return;
  }
  const sections = report.sections.map(section => `<section class="section-block aihot-section"><div class="section-title"><div><span class="eyebrow">DAILY SECTION</span><h2>${escapeHtml(section.label)}</h2></div><span>${section.items.length} 条</span></div><div class="aihot-items">${section.items.map(item => aihotItem(item)).join('') || '<p class="muted">本期无条目。</p>'}</div></section>`).join('');
  const flashes = report.flashes.length ? `<section class="section-block aihot-section"><div class="section-title"><div><span class="eyebrow">FLASHES</span><h2>更多快讯</h2></div><span>${report.flashes.length} 条</span></div><div class="aihot-items">${report.flashes.map(item => aihotItem(item, true)).join('')}</div></section>` : '';
  main.innerHTML = `${header}<section class="aihot-lead"><span class="eyebrow">${formatDate(report.date)} · AIHOT</span><h2>${escapeHtml(report.lead.title || '今日看点')}</h2>${report.lead.paragraph ? `<p>${escapeHtml(report.lead.paragraph)}</p>` : ''}<div class="aihot-lead-links">${safeExternalLink(report.links.aihot || report.attribution.url, '在 AIHOT 阅读整期')}</div></section>
    ${result.stale ? '<p class="review-hint">当前显示上次成功获取的内容；AIHOT 暂时不可用。</p>' : ''}${currentError ? `<p class="review-hint">${escapeHtml(currentError)}</p>` : ''}
    ${sections}${flashes}<p class="aihot-attribution">来源：${safeExternalLink(report.attribution.url || report.links.aihot, report.attribution.name || 'AIHOT')}。标题和摘要可能有误，重要信息请核对原始来源。个人非商业和组织内部使用可直接阅读；对外商业使用须取得 AIHOT 授权。</p>`;
  if (!state.aihot.index && !state.aihot.indexError && !state.aihot.indexLoading) void loadAihotIndex();
}

function normalizedSourceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function aihotInboxItems(result) {
  const report = result?.report;
  if (!report) return [];
  return [...report.sections.flatMap(section => section.items), ...report.flashes].map(item => {
    const url = normalizedSourceUrl(item.links?.original || item.links?.aihot);
    return url ? { url, title: item.title, summary: item.summary || '', sourceName: item.source || 'AIHOT', kind: 'aihot',
      publishedAt: '', sourceDate: report.date, dateKind: '日报日期', feedUrl: result.report.links.aihot || '' } : null;
  }).filter(Boolean);
}

function inboxItems() {
  const items = new Map();
  const add = item => {
    const url = normalizedSourceUrl(item?.url);
    if (url && !items.has(url)) items.set(url, { ...item, url });
  };
  state.inbox.manual.forEach(add);
  for (const result of state.inbox.results.values()) (result.items || []).slice(0, 30).forEach(add);
  aihotInboxItems(state.inbox.aihot).forEach(add);
  for (const decision of Object.values(state.inbox.decisions)) add(decision?.item);
  return [...items.values()].sort((a, b) => (b.publishedAt || b.sourceDate || b.capturedAt || '').localeCompare(a.publishedAt || a.sourceDate || a.capturedAt || ''));
}

function inboxStatus(item) { return ['linked', 'dismissed'].includes(state.inbox.decisions[item.url]?.status) ? state.inbox.decisions[item.url].status : 'pending'; }
function inboxDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); }

async function loadInboxSources(force = false) {
  if (state.inbox.loading) return;
  state.inbox.loading = true;
  const inbox = state.inbox;
  if (state.route.startsWith('#/inbox')) renderInbox();
  const feeds = [...inbox.feeds];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, feeds.length) }, async () => {
    while (next < feeds.length) {
      const url = feeds[next++];
      try {
        const result = await api('/api/feeds/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ url, refresh: force }) });
        inbox.results.set(url, result);
        if (result.error) inbox.errors.set(url, result.error);
        else inbox.errors.delete(url);
      } catch (error) { inbox.errors.set(url, error.message); }
    }
  }));
  if (state.aihot.subscribed) {
    try {
      inbox.aihot = await api(`/api/aihot/daily${force ? '?refresh=1' : ''}`);
      inbox.aihotError = inbox.aihot.stale ? 'AIHOT 暂时不可用，显示上次成功获取的日报。' : '';
    } catch (error) { inbox.aihotError = error.message; }
  } else { inbox.aihot = null; inbox.aihotError = ''; }
  inbox.loading = false;
  inbox.loaded = true;
  if (state.inbox === inbox && state.route.startsWith('#/inbox')) renderInbox();
}

function inboxCard(item) {
  const decision = state.inbox.decisions[item.url];
  const status = inboxStatus(item);
  const project = status === 'linked' ? state.data.projects.find(candidate => candidate.path === decision.projectPath) : null;
  const date = item.publishedAt || item.sourceDate || item.capturedAt || '';
  const dateLabel = item.publishedAt ? '发布时间' : item.sourceDate ? item.dateKind || '来源日期' : item.capturedAt ? '添加时间' : '时间未记录';
  return `<article class="inbox-card" data-url="${escapeAttr(item.url)}"><div class="inbox-meta"><span class="type-pill">${escapeHtml(item.kind === 'aihot' ? 'AIHOT' : item.kind === 'manual' ? '手动链接' : 'RSS/Atom')}</span><span>${escapeHtml(item.sourceName || '未知来源')}</span><span>${escapeHtml(dateLabel)}：${date ? escapeHtml(inboxDate(date)) : '未记录'}</span></div><h3>${escapeHtml(item.title || item.url)}</h3>${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}<div class="inbox-source">${safeExternalLink(item.url, '核对原始来源')}<code>${escapeHtml(item.url)}</code></div>
    <div class="inbox-review">${project ? `<span>已关联 ${safeProjectLink(project)}</span>` : status === 'dismissed' ? '<span>已暂不处理</span>' : '<span>核对原文后再关联项目</span>'}<div><input type="text" list="inbox-projects" aria-label="关联项目路径" placeholder="输入项目路径" value="${escapeAttr(project?.path || '')}"><button type="button" data-action="inbox-link">${project ? '更换关联' : '关联项目'}</button><button type="button" data-action="inbox-propose">生成行动建议</button>${status === 'pending' ? '<button type="button" data-action="inbox-dismiss">暂不处理</button>' : '<button type="button" data-action="inbox-restore">恢复待审阅</button>'}${item.kind === 'manual' ? '<button type="button" data-action="inbox-remove-manual">移除链接</button>' : ''}</div></div></article>`;
}

function safeProjectLink(project) { return `<a href="${projectHref(project.path)}">${escapeHtml(project.title)}</a>`; }

function renderInbox() {
  const all = inboxItems();
  const route = new URLSearchParams(location.hash.split('?')[1] || '');
  const filter = ['pending', 'linked', 'dismissed', 'all'].includes(route.get('filter')) ? route.get('filter') : 'pending';
  const counts = Object.fromEntries(['pending', 'linked', 'dismissed'].map(status => [status, all.filter(item => inboxStatus(item) === status).length]));
  const shown = filter === 'all' ? all : all.filter(item => inboxStatus(item) === filter);
  const visible = shown.slice(0, state.inbox.visible);
  const errors = [...state.inbox.errors].map(([url, message]) => `<li>${safeExternalLink(url, url)}：${escapeHtml(message)}</li>`).join('');
  main.innerHTML = `${sectionHeader('SOURCE INBOX', '来源收件箱', '把外部线索放到一处核对，再决定与哪个 Wiki 项目有关。')}
    <section class="panel inbox-controls"><div><h2>订阅来源</h2><p>AIHOT、RSS/Atom 与手动链接汇集在这里。核对原文后，可关联项目并提出具体行动；订阅和审阅记录按资料库保存在本机。</p><div class="inbox-control-actions"><button type="button" data-action="inbox-aihot" aria-pressed="${state.aihot.subscribed}">${state.aihot.subscribed ? 'AIHOT 已订阅 · 取消' : '订阅 AIHOT 日报'}</button><button type="button" data-action="inbox-refresh" ${state.inbox.loading ? 'disabled' : ''}>${state.inbox.loading ? '正在获取…' : '刷新来源'}</button></div></div><form id="inbox-feed-form"><label for="inbox-feed-url">添加 RSS/Atom 地址</label><div><input id="inbox-feed-url" name="url" type="url" placeholder="https://example.com/feed.xml" required><button type="submit">添加</button></div><label for="inbox-opml">从 OPML 导入订阅源</label><input id="inbox-opml" type="file" accept=".opml,.xml,text/xml,application/xml"><small>最多保存 30 个订阅源。只从公开网站获取，单个源最多读取 1 MB。</small></form></section>
    ${state.inbox.feeds.length ? `<section class="inbox-feed-list"><h2>已添加的订阅源</h2><div>${state.inbox.feeds.map(url => `<div><span>${escapeHtml(state.inbox.results.get(url)?.title || url)}</span>${state.inbox.errors.has(url) ? `<small>获取失败：${escapeHtml(state.inbox.errors.get(url))}</small>` : ''}<button type="button" data-action="inbox-remove-feed" data-url="${escapeAttr(url)}">移除</button></div>`).join('')}</div></section>` : ''}
    <section class="panel inbox-manual"><h2>添加一条链接</h2><form id="inbox-manual-form"><input name="title" placeholder="标题" maxlength="300" required><input name="url" type="url" placeholder="https://example.com/article" required><input name="sourceDate" type="date" aria-label="来源日期（可选）"><button type="submit">加入收件箱</button></form></section>
    ${state.inbox.aihotError ? `<p class="inbox-warning">AIHOT：${escapeHtml(state.inbox.aihotError)}</p>` : ''}${errors ? `<ul class="inbox-warning">${errors}</ul>` : ''}
    <div class="action-tabs">${[['pending', '待审阅'], ['linked', '已关联'], ['dismissed', '暂不处理'], ['all', '全部']].map(([status, label]) => `<a class="filter-chip ${filter === status ? 'active' : ''}" href="#/inbox?filter=${status}">${label} <strong>${status === 'all' ? all.length : counts[status]}</strong></a>`).join('')}</div>
    <datalist id="inbox-projects">${state.data.projects.map(project => `<option value="${escapeAttr(project.path)}" label="${escapeAttr(project.title)}"></option>`).join('')}</datalist>
    <div class="inbox-cards">${visible.length ? visible.map(inboxCard).join('') : `<div class="empty-inline">${state.inbox.loading ? '正在获取来源…' : state.inbox.feeds.length || state.aihot.subscribed ? '这一类目前没有条目。' : '先订阅 AIHOT、添加 RSS/Atom 或手动链接。'}</div>`}</div>${visible.length < shown.length ? `<button type="button" class="project-more" data-action="inbox-more">显示更多（剩余 ${shown.length - visible.length} 条）</button>` : ''}`;
}

function xProfiles() {
  return [...X_SUGGESTIONS, ...state.x.custom.map(handle => ({ handle, name: `@${handle}`, topic: '自定义', why: '你添加的 X 账号' }))];
}

function saveXSubscriptions() {
  try { localStorage.setItem(X_STORAGE_KEY, JSON.stringify(xSnapshot())); } catch {}
  void saveWorkspaceSection('x', xSnapshot());
}

function renderX() {
  const profiles = xProfiles();
  const current = profiles.find(item => item.handle.toLowerCase() === state.x.selected) || profiles[0];
  const subscribed = state.x.subscribed.size;
  const cards = profiles.map(item => {
    const handle = item.handle.toLowerCase();
    const isSubscribed = state.x.subscribed.has(handle);
    const isCustom = state.x.custom.includes(handle);
    return `<article class="x-profile ${current.handle.toLowerCase() === handle ? 'is-selected' : ''}"><div class="x-profile-top"><span class="type-pill">${escapeHtml(item.topic)}</span><span class="x-handle">@${escapeHtml(item.handle)}</span></div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.why)}</p><div class="x-profile-actions"><button type="button" data-action="x-select" data-handle="${escapeAttr(handle)}">选择作者</button><button type="button" data-action="x-toggle" data-handle="${escapeAttr(handle)}" aria-pressed="${isSubscribed}">${isSubscribed ? '已订阅 · 取消' : '加入订阅'}</button>${isCustom ? `<button type="button" class="x-remove" data-action="x-remove" data-handle="${escapeAttr(handle)}" aria-label="移除 @${escapeAttr(handle)}">移除</button>` : ''}</div></article>`;
  }).join('');
  const profileUrl = `https://x.com/${current.handle}`;
  const timeline = state.x.embedFailed
    ? `<div class="x-embed-placeholder"><span aria-hidden="true">↗</span><p>X 的嵌入时间线暂时不可用。请打开 @${escapeHtml(current.handle)} 的主页阅读。</p>${safeExternalLink(profileUrl, '在 X 阅读动态', 'x-direct-button')}<button type="button" data-action="x-load">重试站内预览</button></div>`
    : state.x.embedLoaded
      ? `<p class="x-loading-note">正在尝试加载 X 时间线…</p><iframe class="x-timeline" src="/x-embed?handle=${encodeURIComponent(current.handle)}" title="@${escapeAttr(current.handle)} 的 X 公开时间线" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe><p class="x-embed-help">如果时间线未出现，请${safeExternalLink(profileUrl, '直接在 X 打开主页')}。X 可能要求登录或阻止嵌入。</p>`
      : `<div class="x-embed-placeholder"><span aria-hidden="true">𝕏</span><p>打开 @${escapeHtml(current.handle)} 的 X 主页，阅读最新公开动态。</p>${safeExternalLink(profileUrl, '在 X 阅读动态', 'x-direct-button')}<button type="button" data-action="x-load">尝试站内预览</button><small>预览依赖 X 的嵌入服务，可能被限流。</small></div>`;
  main.innerHTML = `${sectionHeader('DEVELOPER SIGNAL', '开发者动态', '保存值得跟踪的技术作者，从工作台直达他们的 X 动态。')}
    <section class="panel x-intro"><div><strong>已订阅 ${subscribed} 位作者</strong><p>这里的“订阅”是工作台本地清单，不会替你在 X 点关注。阅读会打开 X 原站；站内预览是可选功能，可能因 X 限流而失败。</p></div>${safeExternalLink('https://help.x.com/en/using-x/embed-x-feed', '了解 X 嵌入时间线')}</section>
    <section class="x-layout"><div><div class="section-title"><div><span class="eyebrow">CURATED ACCOUNTS</span><h2>作者清单</h2></div><span>${profiles.length} 位</span></div><div class="x-profiles">${cards}</div><form id="x-add-form" class="panel x-add"><label for="x-add-handle">添加其他开发者</label><div><input id="x-add-handle" name="handle" autocomplete="off" placeholder="输入 @账号 或 X 主页链接" maxlength="80" required><button type="submit">添加账号</button></div><small>只支持公开 X 账号。自定义账号按资料库保存在本机。</small></form></div>
    <aside class="panel x-viewer"><div class="x-viewer-head"><span class="eyebrow">AUTHOR PROFILE</span><h2>${escapeHtml(current.name)}</h2><p>@${escapeHtml(current.handle)} · ${escapeHtml(current.topic)}</p></div>${timeline}</aside></section>`;
}

function renderVault() {
  const { vault, dailyWritable, dailyDir } = state.data;
  const connection = state.connection;
  const preview = connection.preview;
  const previewProjects = preview?.projects.map(item => `<li><strong>${escapeHtml(item.title)}</strong><code>${escapeHtml(item.path)}</code></li>`).join('') || '';
  main.innerHTML = `${sectionHeader('LIBRARY', '当前资料库', '工作台直接读取本地 Markdown 文件，不会复制或上传。')}
    ${vaultBanner()}
    <section class="panel vault-details"><h2>连接状态</h2><dl><div><dt>资料库路径</dt><dd><code>${escapeHtml(vault.path)}</code></dd></div><div><dt>已扫描</dt><dd>${vault.pageCount} 篇 Markdown</dd></div><div><dt>正文范围</dt><dd>${escapeHtml(vault.contentDir || '整个资料库')}</dd></div><div><dt>写入范围</dt><dd>${dailyWritable ? `仅 ${escapeHtml(dailyDir)}/ 中的今日日报` : '只读'}</dd></div></dl></section>
    <section class="panel vault-details"><h2>工作台状态备份</h2><p>订阅、审阅决定和来源行动按当前资料库保存在本机。导出 JSON 可迁移到另一台电脑；导入会替换目标资料库的这些记录。</p><div class="inbox-control-actions"><a class="text-link" href="/api/workspace-state/export" download>导出备份 ↓</a><label>导入备份 <input id="workspace-import" type="file" accept=".json,application/json"></label></div></section>
    <section class="panel vault-details connection-panel"><h2>${vault.demo ? '连接自己的 Wiki' : '切换其他资料库'}</h2><p>选择本机 Markdown 文件夹，先检查识别结果，再确认连接。${state.data.connectionPersistent ? '连接设置保存在本机，重启后自动恢复。' : '当前服务由命令行指定资料库；界面切换在重启后会恢复为启动参数。'}</p>
      <form id="connection-form"><label for="connection-path">资料库文件夹</label><div class="connection-path-row"><input id="connection-path" name="path" value="${escapeAttr(connection.path)}" placeholder="/absolute/path/to/notes" autocomplete="off" required><button type="button" data-action="connection-choose" ${connection.busy ? 'disabled' : ''}>选择文件夹</button></div>
        <div class="connection-options"><label for="connection-content">正文子目录 <small>留空时自动识别 wiki/；否则扫描整个文件夹</small><input id="connection-content" name="contentDir" value="${escapeAttr(connection.contentDir)}" placeholder="自动识别"></label><label for="connection-daily">日报目录 <small>资料库内的相对路径</small><input id="connection-daily" name="dailyDir" value="${escapeAttr(connection.dailyDir)}" placeholder="daily"></label></div>
        <label class="connection-check"><input type="checkbox" name="writeDaily" ${connection.writeDaily ? 'checked' : ''}>允许写入当日日报 <small>仅当日报模板通过检查后可启用</small></label><button type="submit" class="connection-primary" ${connection.busy ? 'disabled' : ''}>${connection.busy ? '正在检查…' : '检查连接'}</button></form>
      ${connection.error ? `<p class="connection-error" role="alert">${escapeHtml(connection.error)}</p>` : ''}
      ${preview ? `<div class="connection-preview"><h3>接入预览</h3><dl><div><dt>完整路径</dt><dd><code>${escapeHtml(preview.path)}</code></dd></div><div><dt>识别页面</dt><dd>${preview.pageCount} 篇 Markdown · ${preview.projectCount} 个项目</dd></div><div><dt>正文范围</dt><dd>${escapeHtml(preview.contentDir || '整个资料库')}</dd></div><div><dt>写入范围</dt><dd>${preview.writeDaily ? `仅 ${escapeHtml(preview.dailyDir)}/ 中的今日日报；模板检查通过` : '只读'}</dd></div></dl>${previewProjects ? `<strong>识别到的项目示例</strong><ul>${previewProjects}</ul>` : '<p>未识别到项目页；仍可搜索和阅读 Markdown。</p>'}<button type="button" class="connection-primary" data-action="connection-activate" ${connection.busy ? 'disabled' : ''}>确认连接此文件夹</button></div>` : ''}
    </section>`;
}

function connectionPayload() {
  const form = document.querySelector('#connection-form');
  const data = new FormData(form);
  return {
    path: String(data.get('path') || '').trim(),
    contentDir: String(data.get('contentDir') || '').trim(),
    dailyDir: String(data.get('dailyDir') || '').trim() || 'daily',
    writeDaily: data.has('writeDaily')
  };
}

function connectionPost(endpoint, payload = {}) {
  return api(`/api/connection/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' },
    body: JSON.stringify(payload)
  });
}

function renderProjects() {
  const projects = state.data.projects;
  main.innerHTML = `${sectionHeader('PROJECTS', '项目脉络', '按最近记录排序。进展和后续事项均保留原文日期，供你核对。')}
    <div class="projects-tools"><span id="project-count">共 ${projects.length} 个项目</span><input id="project-filter" type="search" value="${escapeAttr(state.projectFilter)}" placeholder="筛选项目名称或路径…" aria-label="筛选项目" /></div>
    <div class="project-grid" id="project-grid"></div><button type="button" class="project-more" data-action="project-more" hidden>显示更多项目</button>`;
  renderProjectList();
}

function renderProjectList() {
  const projects = matchingProjects(state.projectFilter);
  const visible = projects.slice(0, state.projectVisible);
  document.querySelector('#project-count').textContent = `匹配 ${projects.length} 个项目 · 显示 ${visible.length} 个`;
  document.querySelector('#project-grid').innerHTML = visible.map(project => projectCard(project)).join('') || '<div class="empty-inline">没有匹配的项目。</div>';
  const more = document.querySelector('[data-action="project-more"]');
  more.hidden = visible.length >= projects.length;
  more.textContent = `显示更多项目（剩余 ${projects.length - visible.length} 个）`;
}

function renderProject(path) {
  const project = state.data.projects.find(item => item.path === path);
  if (!project) return renderNotFound();
  const digest = project.digest;
  const progress = digest.progress.length
    ? `<ul class="detail-list">${digest.progress.map((item, index) => `<li>${escapeHtml(item)}<div>${evidenceLink(digest.progressEvidence?.[index])}</div></li>`).join('')}</ul>`
    : '<p class="muted">项目页暂无可提取的进展段落。</p>';
  const projectActions = state.data.actions.filter(item => item.projectPath === path || item.adoption?.projectPath === path);
  const actions = projectActions.length
    ? `<div class="candidate-list project-candidate-list">${projectActions.map(candidateRow).join('')}</div>`
    : '<p class="muted">项目页暂无可提取的后续事项。</p>';
  const linkedSources = Object.values(state.inbox.decisions).filter(item => item?.status === 'linked' && item.projectPath === path && item.item && normalizedSourceUrl(item.item.url)).slice(-20).reverse();
  main.innerHTML = `<div class="back-row"><a href="#/projects">← 全部项目</a><span> / ${escapeHtml(project.id)}</span></div>
    <div class="project-hero"><div class="hero-meta"><span class="type-pill">项目</span><span>进展记录至 ${formatDate(digest.progressDate || project.date)}</span></div><h1>${escapeHtml(project.title)}</h1><p>${escapeHtml(digest.goal || '项目目标请查看原文。')}</p>${digest.goalEvidence ? evidenceLink(digest.goalEvidence) : ''}<div><a class="primary-button as-link" href="${pageHref(project.path)}">阅读项目原文 <span>↗</span></a></div></div>
    <div class="detail-grid"><section class="panel detail-panel"><div class="panel-title"><div><span class="eyebrow">RECENT RECORD</span><h2>最近进展</h2></div><span class="panel-date">${formatDate(digest.progressDate)}</span></div>${progress}</section>
    <section class="panel detail-panel"><div class="panel-title"><div><span class="eyebrow">ACTIONS & OUTCOMES</span><h2>后续事项与结果</h2></div></div>${actions}${state.data.dailyWritable && !state.data.today.exists ? '<p class="helper-text">在「今日」初始化日报后，可选取一项加入计划。</p>' : ''}</section></div>
    ${linkedSources.length ? `<section class="section-block"><div class="section-title"><div><span class="eyebrow">REVIEWED SOURCES</span><h2>已关联的外部线索</h2><p>在收件箱中手动关联，尚未写入 Wiki。</p></div><a href="#/inbox?filter=linked">打开来源收件箱 ↗</a></div><div class="inbox-project-sources">${linkedSources.map(({ item }) => `<article><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.sourceName || '外部链接')}</span>${safeExternalLink(item.url, '核对来源')}</article>`).join('')}</div></section>` : ''}
    <div class="source-note"><strong>如何理解这些信息</strong><p>内容来自项目 Markdown；日期表示文档记录的时间，不代表今天仍在执行。计划需由你主动采纳。</p></div>`;
}

function renderSearchShell() {
  const route = new URLSearchParams(location.hash.split('?')[1] || '');
  const query = route.get('q') || '';
  const type = route.get('type') || 'all';
  main.innerHTML = `${sectionHeader('LIBRARY', '在资料库中查找', '搜索 Markdown 页面并打开原文。')}
    <div class="search-panel"><form id="page-search"><div class="large-search"><span>⌕</span><input name="q" type="search" value="${escapeAttr(query)}" placeholder="输入标题、术语或正文关键词…" autofocus /><button type="submit">搜索 ↗</button></div></form><div class="type-filters">${Object.entries({ all: '全部', project: '项目', concept: '概念', source: '资料', insight: '洞察', entity: '实体', personal: '个人', daily: '日报', other: '笔记' }).map(([key, label]) => `<a class="filter-chip ${type === key ? 'active' : ''}" href="#/search?q=${encodeURIComponent(query)}&type=${key}">${label}</a>`).join('')}</div></div>
    <div id="search-results" class="search-results">${query ? '<div class="loading-state">正在搜索…</div>' : '<div class="search-hint"><span>⌕</span><h3>从一个问题开始</h3><p>支持中文词语、英文术语和多词组合搜索；点击结果可查看完整原文。</p></div>'}</div>`;
  if (query) loadSearchResults(query, type);
}

async function loadSearchResults(query, type) {
  const requestId = ++state.searchRequest;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`);
    if (requestId !== state.searchRequest || !location.hash.startsWith('#/search')) return;
    const target = document.querySelector('#search-results');
    if (!target) return;
    target.innerHTML = `<div class="results-count">找到 ${data.results.length} 条结果${data.results.length === 40 ? ' · 显示前 40 条' : ''}</div>${data.results.length ? data.results.map(item => `<a class="result-card" href="${item.type === 'project' ? projectHref(item.path) : pageHref(item.path)}"><div class="result-meta"><span class="type-pill">${typeLabels[item.type] || '页面'}</span><span>${formatDate(item.date)}</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.excerpt || item.path)}</p><small>${escapeHtml(item.path)}</small><span class="arrow">↗</span></a>`).join('') : '<div class="search-hint"><h3>没有找到相关页面</h3><p>可以尝试更短的关键词或切换类型。</p></div>'}`;
  } catch (error) { notice(error.message, true); }
}

async function renderPage(path, heading = '', line = 0) {
  main.innerHTML = '<div class="loading-state">正在打开原文…</div>';
  try {
    const { page } = await api(`/api/page?path=${encodeURIComponent(path)}`);
    const back = page.type === 'project' ? projectHref(path) : '#/search';
    const sourceList = (page.sourceAvailability || []).slice(0, 8).map(item => {
      const safe = item.kind === 'relative' && item.exists && item.readable ? item.source : null;
      const external = item.kind === 'external' ? item.source : null;
      const status = item.kind === 'external' ? '<span>外部链接</span>' : item.kind === 'absolute' ? '<span>本机路径未核验</span>' : item.exists ? item.readable ? '' : '<span>其他格式</span>' : '<span class="missing-source">当前副本缺失</span>';
      return `<div class="source-entry">${safe ? `<a href="${pageHref(safe)}">${escapeHtml(item.source)} ↗</a>` : external ? `<a href="${escapeAttr(external)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source)} ↗</a>` : escapeHtml(item.source)}${status}</div>`;
    }).join('');
    main.innerHTML = `<div class="back-row"><a href="${back}">← ${page.type === 'project' ? '项目概览' : '知识搜索'}</a><span> / 原文</span></div><div class="reader-shell"><aside class="reader-rail"><span class="eyebrow">SOURCE DOCUMENT</span><span class="type-pill">${typeLabels[page.type] || '原文'}</span><h2>${escapeHtml(page.title)}</h2><p class="reader-path">${escapeHtml(page.path)}</p>${page.attributes.updated ? `<div class="reader-meta"><span>页面 updated</span><strong>${formatDate(page.attributes.updated)}</strong></div>` : ''}${page.attributes.confidence ? `<div class="reader-meta"><span>文档置信度</span><strong>${escapeHtml(page.attributes.confidence)}</strong></div>` : ''}${sourceList ? `<div class="rail-divider"></div><span class="mini-label">页面来源</span><div class="source-list">${sourceList}</div>` : ''}<div class="rail-divider"></div><span class="mini-label">页面目录</span><div class="toc">${page.headings.slice(0, 25).map(item => `<button type="button" data-action="jump" data-heading="${escapeAttr(item)}">${escapeHtml(item)}</button>`).join('')}</div></aside><article class="markdown-body">${page.html}</article></div>`;
    if (heading || line) requestAnimationFrame(() => {
      const targets = [...document.querySelectorAll('.markdown-body [data-line]')];
      const target = targets.find(element => line && Number(element.dataset.line) === line)
        || (line && targets.filter(element => Number(element.dataset.line) < line && Number(element.dataset.lineEnd) >= line)
          .sort((a, b) => (Number(a.dataset.lineEnd) - Number(a.dataset.line)) - (Number(b.dataset.lineEnd) - Number(b.dataset.line)))[0])
        || (heading && targets.find(element => element.dataset.heading === heading || headingSlug(element.dataset.heading) === headingSlug(heading)));
      target?.scrollIntoView({ block: 'start' });
    });
  } catch (error) { main.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`; }
}

function renderNotFound() { main.innerHTML = '<div class="error-state">找不到这个页面。<p><a href="#/today">返回今日工作台</a></p></div>'; }

function renderUnindexed() {
  const pages = state.data.unindexed;
  main.innerHTML = `<div class="back-row"><a href="#/today">← 工作台</a></div>${sectionHeader('INDEX REVIEW', '索引待补条目', `这些页面已存在于资料库，但尚未列入 ${state.data.indexPath}。这里只提示，不自动修改索引。`)}
    <div class="candidate-list">${pages.length ? pages.map(page => `<div class="candidate-row"><div class="candidate-icon">↗</div><div class="candidate-body"><a class="candidate-title" href="${pageHref(page.path)}">${escapeHtml(page.title)}</a><p>${escapeHtml(page.path)}</p></div></div>`).join('') : '<div class="empty-inline">当前没有待补条目。</div>'}</div>`;
}

function renderWeekly() {
  const review = state.data.weeklyReview || { startDate: '', endDate: '', unfinished: [], deferred: [], newPlans: [] };
  const decisions = state.weeklyDecisions;
  const itemRow = item => {
    const decision = decisions[item.id];
    const project = state.data.projects.find(project => project.path === item.projectPath);
    return `<div class="candidate-row"><div class="candidate-icon">↗</div><div class="candidate-body"><div class="action-title-line">${project ? safeProjectLink(project) : '<span class="candidate-title">未关联项目</span>'}${decision ? `<span class="action-status">${({ continue: '继续', reschedule: '已改期', invalidated: '已失效' })[decision.status]}${decision.targetDate ? ` · ${escapeHtml(decision.targetDate)}` : ''}</span>` : ''}</div><p>${escapeHtml(item.text)}</p>${evidenceLink(item.evidence)}${item.count ? `<small>已延期 ${item.count} 次</small>` : ''}${decision?.note ? `<small>${escapeHtml(decision.note)}</small>` : ''}</div><div class="candidate-actions"><button type="button" data-action="weekly-decision" data-id="${item.id}" data-status="continue">继续</button><button type="button" data-action="weekly-decision" data-id="${item.id}" data-status="reschedule">改期</button><button type="button" data-action="weekly-decision" data-id="${item.id}" data-status="invalidated">失效</button></div></div>`;
  };
  const block = (title, description, items) => `<section class="section-block"><div class="section-title"><div><h2>${title}</h2><p>${description}</p></div></div><div class="candidate-list">${items.length ? items.map(itemRow).join('') : '<div class="empty-inline">本周没有这类事项。</div>'}</div></section>`;
  main.innerHTML = `${sectionHeader('WEEKLY REVIEW', '每周回顾', `${review.startDate} 至 ${review.endDate}；汇总过去七天的日报与最新周报。`)}
    ${block('未完成的日报计划', '逐条核对原始日报，选择继续、改期或失效。', review.unfinished)}
    ${block('反复延期', '同一已采纳事项至少两次记录延期，且最近一次仍为延期。', review.deferred)}
    ${block('新周报计划', '来自最近七天最新周报的计划；核对原文后再决定。', review.newPlans)}`;
}

function setActive(section) {
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === section));
  document.querySelector('#breadcrumb-current').textContent = ({ today: '首页', projects: '项目', actions: '行动审阅', weekly: '每周回顾', aihot: 'AI 行业日报', inbox: '来源收件箱', x: '开发者动态', vault: '资料库', search: '知识搜索', page: '原文', project: '项目详情', unindexed: '索引待补' })[section] || '工作台';
  document.querySelector('.sidebar').classList.remove('open');
}

function renderRoute() {
  if (!state.data) return;
  const hash = location.hash || '#/today';
  const route = hash.split('?')[0];
  const segments = route.replace(/^#\//, '').split('/');
  const section = segments[0];
  state.route = hash;
  setActive(section === 'page' && decodeURIComponent(segments[1] || '') === state.data.overviewPath ? 'overview' : section);
  if (section === 'today') renderToday();
  else if (section === 'projects') renderProjects();
  else if (section === 'actions') renderActions();
  else if (section === 'weekly') renderWeekly();
  else if (section === 'aihot') {
    renderAihot();
    const date = aihotSelectedDate();
    if (state.aihot.reports.has(date || 'latest')) void loadAihotDaily(date);
    if (state.aihot.index) void loadAihotIndex();
  }
  else if (section === 'inbox') {
    renderInbox();
    if (!state.inbox.loaded && !state.inbox.loading) void loadInboxSources();
  }
  else if (section === 'x') renderX();
  else if (section === 'vault') renderVault();
  else if (section === 'project') renderProject(decodeURIComponent(segments[1] || ''));
  else if (section === 'search') renderSearchShell();
  else if (section === 'unindexed') renderUnindexed();
  else if (section === 'page') {
    const params = new URLSearchParams(hash.split('?')[1] || '');
    renderPage(decodeURIComponent(segments[1] || ''), params.get('heading') || '', Number(params.get('line') || 0));
  }
  else renderNotFound();
  if (section !== 'page') window.scrollTo({ top: 0 });
}

document.querySelector('#global-search').addEventListener('submit', event => {
  event.preventDefault();
  location.hash = `#/search?q=${encodeURIComponent(document.querySelector('#global-query').value.trim())}`;
});
document.querySelector('#mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
window.addEventListener('hashchange', renderRoute);
main.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const action = control.dataset.action;
  if (action === 'inbox-aihot') {
    state.aihot.subscribed = !state.aihot.subscribed;
    try { localStorage.setItem('wiki-workbench-aihot-subscription', state.aihot.subscribed ? '1' : '0'); } catch {}
    void saveWorkspaceSection('aihot', { subscribed: state.aihot.subscribed });
    state.aihot.nextAutoAt = 0;
    if (state.aihot.subscribed) { state.inbox.loaded = false; void loadInboxSources(); }
    else { state.inbox.aihot = null; state.inbox.aihotError = ''; renderInbox(); }
    return;
  }
  if (action === 'inbox-refresh') { void loadInboxSources(true); return; }
  if (action === 'inbox-more') { state.inbox.visible += INBOX_BATCH_SIZE; renderInbox(); return; }
  if (action === 'inbox-remove-feed') {
    const url = control.dataset.url;
    state.inbox.feeds = state.inbox.feeds.filter(item => item !== url);
    state.inbox.results.delete(url);
    state.inbox.errors.delete(url);
    try { saveInboxSettings(); } catch { return notice('浏览器无法保存收件箱', true); }
    renderInbox();
    return;
  }
  if (action.startsWith('inbox-') && ['inbox-link', 'inbox-dismiss', 'inbox-restore', 'inbox-remove-manual', 'inbox-propose'].includes(action)) {
    const card = control.closest('.inbox-card');
    const url = card?.dataset.url;
    const item = inboxItems().find(entry => entry.url === url);
    if (!item) return;
    if (action === 'inbox-propose') {
      const projectPath = card.querySelector('input[list]')?.value.trim();
      if (!state.data.projects.some(project => project.path === projectPath)) return notice('请先选择准确的关联项目', true);
      const task = prompt(`核对来源后，为「${item.title}」写一条具体行动（1–180 字）：`, '');
      if (task === null) return;
      const text = task.trim().replace(/[\r\n|]+/g, ' ');
      if (!text || text.length > 180) return notice('行动应为 1–180 字', true);
      if (state.inbox.sourceActions.some(entry => entry.url === url && entry.projectPath === projectPath && entry.text === text)) return notice('这条行动已在审阅清单中');
      state.inbox.sourceActions.push({ url, projectPath, text, title: item.title, sourceName: item.sourceName || '', createdAt: new Date().toISOString() });
      state.inbox.decisions[url] = { status: 'linked', projectPath, item };
      try { await saveInboxSettings(); await refresh(true); location.hash = '#/actions'; renderRoute(); notice('行动建议已加入审阅清单'); }
      catch (error) { notice(error.message, true); }
      return;
    }
    if (action === 'inbox-remove-manual') {
      state.inbox.manual = state.inbox.manual.filter(entry => entry.url !== url);
      delete state.inbox.decisions[url];
    } else if (action === 'inbox-restore') delete state.inbox.decisions[url];
    else if (action === 'inbox-dismiss') state.inbox.decisions[url] = { status: 'dismissed', item };
    else {
      const projectPath = card.querySelector('input[list]')?.value.trim();
      if (!state.data.projects.some(project => project.path === projectPath)) return notice('请输入清单中准确的项目路径', true);
      state.inbox.decisions[url] = { status: 'linked', projectPath, item };
    }
    try { saveInboxSettings(); } catch { return notice('浏览器无法保存收件箱', true); }
    renderInbox();
    notice(action === 'inbox-link' ? '已关联项目' : '审阅状态已更新');
    return;
  }
  if (action === 'connection-choose') {
    state.connection = { ...state.connection, ...connectionPayload(), busy: true, error: '', preview: null };
    renderVault();
    try {
      const result = await connectionPost('choose');
      state.connection.path = result.path;
    } catch (error) {
      if (error.message !== '未选择文件夹') state.connection.error = error.message;
    } finally { state.connection.busy = false; renderVault(); }
    return;
  }
  if (action === 'connection-activate') {
    const preview = state.connection.preview;
    if (!preview) return;
    state.connection.busy = true;
    renderVault();
    try {
      await state.workspaceSave;
      await connectionPost('activate', { token: preview.token });
      state.connection.preview = null;
      state.connection.error = '';
      await refresh();
      renderRoute();
      notice('已连接资料库');
    } catch (error) {
      state.connection.error = error.message;
    } finally { state.connection.busy = false; if (state.route.split('?')[0] === '#/vault') renderVault(); }
    return;
  }
  if (action === 'x-select') {
    state.x.selected = control.dataset.handle;
    state.x.embedLoaded = false;
    state.x.embedFailed = false;
    renderX();
    return;
  }
  if (action === 'x-toggle') {
    const handle = control.dataset.handle;
    if (state.x.subscribed.has(handle)) state.x.subscribed.delete(handle);
    else state.x.subscribed.add(handle);
    try { saveXSubscriptions(); } catch { notice('浏览器无法保存账号清单', true); }
    renderX();
    return;
  }
  if (action === 'x-remove') {
    const handle = control.dataset.handle;
    state.x.custom = state.x.custom.filter(item => item !== handle);
    state.x.subscribed.delete(handle);
    if (state.x.selected === handle) { state.x.selected = 'simonw'; state.x.embedLoaded = false; state.x.embedFailed = false; }
    try { saveXSubscriptions(); } catch { notice('浏览器无法保存账号清单', true); }
    renderX();
    return;
  }
  if (action === 'x-load') {
    state.x.embedLoaded = true;
    state.x.embedFailed = false;
    renderX();
    return;
  }
  if (action === 'aihot-subscribe') {
    state.aihot.subscribed = !state.aihot.subscribed;
    try { localStorage.setItem('wiki-workbench-aihot-subscription', state.aihot.subscribed ? '1' : '0'); } catch {}
    void saveWorkspaceSection('aihot', { subscribed: state.aihot.subscribed });
    state.aihot.nextAutoAt = 0;
    state.inbox.loaded = false;
    if (!state.aihot.subscribed) state.inbox.aihot = null;
    renderAihot();
    if (state.aihot.subscribed) void checkAihotSubscription();
    return;
  }
  if (action === 'aihot-refresh') {
    const date = aihotSelectedDate();
    state.aihot.error = '';
    void loadAihotDaily(date, true);
    void loadAihotIndex(true);
    return;
  }
  if (action === 'project-more') {
    state.projectVisible += PROJECT_BATCH_SIZE;
    renderProjectList();
    return;
  }
  if (action === 'action-more') {
    state.actionVisible += ACTION_BATCH_SIZE;
    renderActions();
    return;
  }
  if (action === 'refresh-actions') {
    try { await refresh(true); renderRoute(); notice('已重新读取日报和本机结果记录'); }
    catch (error) { notice(error.message, true); }
    return;
  }
  if (action === 'jump') {
    [...document.querySelectorAll('.markdown-body [data-heading]')].find(element => element.dataset.heading === control.dataset.heading)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'review') {
    const item = state.data.actions.find(candidate => candidate.id === control.dataset.id);
    if (!item || !['pending', 'deferred', 'ignored'].includes(control.dataset.choice)) return;
    try {
      const choices = reviewChoices();
      if (control.dataset.choice === 'pending') delete choices[item.id];
      else choices[item.id] = control.dataset.choice;
      try { localStorage.setItem(reviewStorageKey(), JSON.stringify(choices)); } catch {}
      void saveWorkspaceSection('reviewChoices', choices);
      renderRoute();
      notice(control.dataset.choice === 'pending' ? '已恢复待判断' : `已${control.dataset.choice === 'deferred' ? '暂缓' : '忽略'}`);
    } catch { notice('浏览器无法保存审阅状态', true); }
    return;
  }
  if (action === 'remove-source-action') {
    const item = state.data.actions.find(candidate => candidate.id === control.dataset.id);
    if (!item || item.evidence.kind !== 'external' || item.adoption) return;
    if (!confirm(`移除行动建议「${item.text}」？来源关联仍会保留。`)) return;
    state.inbox.sourceActions = state.inbox.sourceActions.filter(entry => !(entry.url === item.evidence.url && entry.projectPath === item.projectPath && entry.text === item.text));
    try { await saveInboxSettings(); await refresh(true); renderRoute(); notice('行动建议已移除'); }
    catch (error) { notice(error.message, true); }
    return;
  }
  if (action === 'weekly-decision') {
    const review = state.data.weeklyReview;
    const item = [...review.unfinished, ...review.deferred, ...review.newPlans].find(entry => entry.id === control.dataset.id);
    if (!item) return notice('回顾事项已变化，请刷新', true);
    const status = control.dataset.status;
    let targetDate = '', note = '';
    if (status === 'reschedule') {
      targetDate = prompt('改期至哪一天？请输入 YYYY-MM-DD：', '') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || Number.isNaN(Date.parse(`${targetDate}T00:00:00Z`))) return notice('日期格式不正确', true);
    }
    if (status === 'invalidated' || status === 'reschedule') {
      const answer = prompt(status === 'invalidated' ? '失效原因：' : '改期原因（可留空）：', '');
      if (answer === null) return;
      note = answer.trim().slice(0, 400);
      if (status === 'invalidated' && !note) return notice('请填写失效原因', true);
    }
    state.weeklyDecisions[item.id] = { status, targetDate, note, at: new Date().toISOString() };
    try { await saveWorkspaceSection('weeklyDecisions', state.weeklyDecisions); renderWeekly(); notice('回顾决定已保存'); }
    catch (error) { notice(error.message, true); }
    return;
  }
  if (action === 'plan') {
    const item = state.data.actions.find(candidate => candidate.id === control.dataset.id);
    const projectPath = item?.projectPath || control.closest('.candidate-row')?.querySelector('.action-project')?.value;
    const project = state.data.projects.find(candidate => candidate.path === projectPath);
    if (!project) return notice('请选择关联项目', true);
    const text = item?.text;
    if (!text) return notice('来源记录已变化，请刷新页面', true);
    const evidence = item.evidence;
    if (!evidence) return notice('来源未定位，请刷新页面后重试', true);
    const existing = state.data.today.plans.find(plan => plan.priority === Number(control.dataset.priority));
    const label = state.data.dailyFormat.priorityLabels[Number(control.dataset.priority) - 1];
    const preview = [`采纳为 ${label} → ${state.data.today.path}`, `任务：${text}`, `来源：${evidenceLabel(evidence)}`];
    if (existing?.text) preview.push(`将覆盖：${existing.text}`);
    if (!confirm(preview.join('\n'))) return;
    try {
      const { today } = await api('/api/daily', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ action: 'plan', projectPath: project.path, priority: Number(control.dataset.priority), text, sourceLine: evidence.line, sourcePath: evidence.sourcePath, sourceKind: evidence.kind, replace: Boolean(existing?.text) }) });
      state.data.today = today; await refresh(); renderRoute(); notice(`已加入今日 ${label}`);
    } catch (error) { notice(error.message, true); }
  }
  if (action === 'outcome') {
    const item = state.data.actions.find(candidate => candidate.id === control.dataset.id);
    if (!item?.adoption) return notice('请先采纳该事项', true);
    const status = control.dataset.status;
    const syncDaily = control.dataset.syncDaily === '1';
    const promptText = status === 'deferred' ? '延期到何时？原因是什么？' : status === 'invalidated' ? '为什么这项计划已失效？' : status === 'completed' ? '完成依据或结果（可留空）' : '';
    const note = promptText ? prompt(promptText, actionOutcome(item)?.status === 'completed' ? actionOutcome(item).note : '') : '';
    if (note === null) return;
    if (syncDaily) {
      if (!canSyncDaily(item)) return notice('只能同步勾选今日日报，请刷新后重试', true);
      const label = state.data.dailyFormat.priorityLabels[item.adoption.priority - 1];
      if (!confirm(`记录完成，并勾选今日日报中的 ${label}？\n文件：${item.adoption.path}\n任务：${item.text}\n来源：${evidenceLabel(item.evidence)}`)) return;
    }
    try {
      const result = await api('/api/actions/outcome', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ id: item.id, status, note, syncDaily }) });
      await refresh(); renderRoute();
      notice(result.syncError ? `结果已记录，但日报未勾选：${result.syncError}` : syncDaily ? '已记录完成并勾选今日日报' : `已记录：${actionLabels[status]}`, Boolean(result.syncError));
    } catch (error) { notice(error.message, true); }
    return;
  }
  if (action === 'resolve-outcome') {
    const item = state.data.actions.find(candidate => candidate.id === control.dataset.id);
    if (!item?.adoption || !actionConflict(item)) return;
    const status = item.adoption.done ? 'completed' : 'planned';
    try {
      await api('/api/actions/outcome', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ id: item.id, status, note: '按日报当前勾选状态校准' }) });
      await refresh(); renderRoute(); notice('已按日报勾选状态校准工作台记录');
    } catch (error) { notice(error.message, true); }
    return;
  }
  if (action === 'init') {
    try {
      const { today } = await api('/api/daily', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ action: 'init' }) });
      state.data.today = today; renderRoute(); notice('今日日报已创建，可以选择任务和记录进展');
    } catch (error) { notice(error.message, true); }
  }
});
main.addEventListener('submit', async event => {
  if (event.target.id === 'inbox-feed-form') {
    event.preventDefault();
    const url = normalizedSourceUrl(new FormData(event.target).get('url'));
    if (!url) return notice('请输入有效的 RSS/Atom 地址', true);
    if (state.inbox.feeds.includes(url)) return notice('该订阅源已添加');
    if (state.inbox.feeds.length >= 30) return notice('最多添加 30 个订阅源', true);
    state.inbox.feeds.push(url);
    try { saveInboxSettings(); } catch { state.inbox.feeds.pop(); return notice('浏览器无法保存订阅源', true); }
    state.inbox.loaded = false;
    renderInbox();
    void loadInboxSources();
    return;
  }
  if (event.target.id === 'inbox-manual-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const url = normalizedSourceUrl(form.get('url'));
    const title = String(form.get('title') || '').trim().slice(0, 300);
    if (!url || !title) return notice('请填写标题和有效链接', true);
    if (state.inbox.manual.some(item => item.url === url)) return notice('该链接已添加');
    if (state.inbox.manual.length >= 100) return notice('最多保存 100 条手动链接', true);
    const sourceDate = String(form.get('sourceDate') || '');
    state.inbox.manual.unshift({ url, title, summary: '', sourceName: new URL(url).hostname, kind: 'manual', sourceDate: /^\d{4}-\d{2}-\d{2}$/.test(sourceDate) ? sourceDate : '', dateKind: '来源日期', capturedAt: new Date().toISOString() });
    try { saveInboxSettings(); } catch { state.inbox.manual.shift(); return notice('浏览器无法保存链接', true); }
    location.hash = '#/inbox?filter=pending';
    renderInbox();
    notice('链接已加入待审阅');
    return;
  }
  if (event.target.id === 'connection-form') {
    event.preventDefault();
    state.connection = { ...state.connection, ...connectionPayload(), busy: true, error: '', preview: null };
    renderVault();
    try { state.connection.preview = await connectionPost('inspect', state.connection); }
    catch (error) { state.connection.error = error.message; }
    finally { state.connection.busy = false; renderVault(); }
    return;
  }
  if (event.target.id === 'x-add-form') {
    event.preventDefault();
    const handle = xHandle(new FormData(event.target).get('handle'));
    if (!handle) return notice('请输入有效的 X 账号或主页链接', true);
    if (!xProfiles().some(item => item.handle.toLowerCase() === handle)) {
      if (state.x.custom.length >= 30) return notice('最多添加 30 个自定义账号', true);
      state.x.custom.push(handle);
    }
    state.x.subscribed.add(handle);
    state.x.selected = handle;
    state.x.embedLoaded = false;
    state.x.embedFailed = false;
    try { saveXSubscriptions(); } catch { notice('浏览器无法保存账号清单', true); }
    renderX();
    return;
  }
  if (event.target.id === 'page-search') {
    event.preventDefault();
    const form = new FormData(event.target);
    location.hash = `#/search?q=${encodeURIComponent(String(form.get('q') || '').trim())}`;
  }
  if (event.target.id === 'capture-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const { today } = await api('/api/daily', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ action: 'record', text: form.get('text'), projectPath: form.get('projectPath') }) });
      state.data.today = today; renderRoute(); notice('已写入今日日报');
    } catch (error) { notice(error.message, true); }
  }
});
main.addEventListener('input', event => {
  if (event.target.closest('#connection-form') && state.connection.preview) {
    state.connection.preview = null;
    document.querySelector('.connection-preview')?.remove();
  }
  if (event.target.id === 'project-filter') {
    state.projectFilter = event.target.value;
    state.projectVisible = PROJECT_BATCH_SIZE;
    renderProjectList();
  }
  if (event.target.id === 'capture-project-filter') {
    const select = document.querySelector('#capture-project-list');
    const matches = matchingProjects(event.target.value);
    select.innerHTML = `<option value="">选择关联项目（匹配 ${matches.length} 项）</option>${captureProjectOptions(event.target.value)}`;
    if (matches.length === 1) select.value = matches[0].path;
  }
});

main.addEventListener('change', event => {
  if (event.target.id === 'aihot-date') location.hash = event.target.value ? `#/aihot?date=${encodeURIComponent(event.target.value)}` : '#/aihot';
  if (event.target.id === 'inbox-opml') void importInboxOpml(event.target.files?.[0]);
  if (event.target.id === 'workspace-import') void importWorkspaceBackup(event.target.files?.[0]);
});

async function importWorkspaceBackup(file) {
  if (!file) return;
  if (file.size > 1_000_000) return notice('备份文件不能超过 1 MB', true);
  try {
    const backup = JSON.parse(await file.text());
    if (backup.version !== 1 || !backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) throw new Error('备份格式不正确');
    const counts = [`RSS ${backup.data.inbox?.feeds?.length || 0}`, `链接 ${backup.data.inbox?.manual?.length || 0}`, `行动建议 ${backup.data.inbox?.sourceActions?.length || 0}`, `审阅 ${Object.keys(backup.data.reviewChoices || {}).length}`, `周回顾 ${Object.keys(backup.data.weeklyDecisions || {}).length}`];
    const source = backup.vaultPath || backup.vaultId || '未知资料库';
    if (!confirm(`将来自 ${source} 的备份导入当前资料库 ${state.data.vault.path}。\n包含 ${counts.join('、')}。\n这会替换当前资料库的工作台状态。确认导入？`)) return;
    await saveWorkspaceSections(backup.data, true, backup.actionOutcomes);
    await refresh(true);
    renderVault();
    notice('备份已导入');
  } catch (error) { notice(`导入失败：${error.message}`, true); }
}

async function importInboxOpml(file) {
  if (!file) return;
  if (file.size > 1_000_000) return notice('OPML 文件不能超过 1 MB', true);
  try {
    const document = new DOMParser().parseFromString(await file.text(), 'application/xml');
    if (document.querySelector('parsererror') || document.documentElement.tagName.toLowerCase() !== 'opml') throw new Error('OPML 文件格式不正确');
    const urls = [...document.querySelectorAll('outline[xmlUrl]')].map(node => normalizedSourceUrl(node.getAttribute('xmlUrl'))).filter(Boolean);
    if (!urls.length) throw new Error('OPML 文件中没有 RSS/Atom 地址');
    const before = state.inbox.feeds.length;
    state.inbox.feeds = [...new Set([...state.inbox.feeds, ...urls])].slice(0, 30);
    saveInboxSettings();
    state.inbox.loaded = false;
    renderInbox();
    notice(`已导入 ${state.inbox.feeds.length - before} 个订阅源${state.inbox.feeds.length === 30 ? '（已达上限）' : ''}`);
    void loadInboxSources();
  } catch (error) { notice(error.message, true); }
}

window.setInterval(() => void checkAihotSubscription(), 15 * 60_000);
window.addEventListener('message', event => {
  const frame = document.querySelector('.x-timeline');
  if (state.route.split('?')[0] !== '#/x' || !frame || event.source !== frame.contentWindow) return;
  if (event.data?.type !== 'wiki-workbench-x-embed' || event.data.status !== 'unavailable') return;
  state.x.embedLoaded = false;
  state.x.embedFailed = true;
  renderX();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void checkAihotSubscription(); });
refresh().then(() => { renderRoute(); void checkAihotSubscription(); }).catch(error => { main.innerHTML = `<div class="error-state">无法读取 Wiki：${escapeHtml(error.message)}</div>`; });

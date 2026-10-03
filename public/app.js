const state = { data: null, route: '', searchRequest: 0 };
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
const formatDate = value => value ? value.replaceAll('-', '.') : '日期未记录';
const priorities = () => state.data.dailyFormat.priorityLabels.map((label, index) => ({ label, priority: index + 1 }));
const headingSlug = value => String(value || '').toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const evidenceTypes = { project: '项目页', weekly: '周报', index: '索引' };
const evidenceLabel = evidence => `${evidenceTypes[evidence.kind] || '原文'} · ${evidence.sourcePath}:${evidence.line} · ${formatDate(evidence.date)}`;
const evidenceLink = evidence => evidence
  ? `<a class="evidence-link" href="${pageHref(evidence.sourcePath, evidence.heading, evidence.line)}">${escapeHtml(evidenceLabel(evidence))} ↗</a>`
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

async function refresh() {
  state.data = await api('/api/bootstrap');
  document.querySelector('#top-date').textContent = state.data.today.date.replaceAll('-', ' / ');
  const overview = document.querySelector('#nav-overview');
  overview.hidden = !state.data.overviewPath;
  if (state.data.overviewPath) overview.href = pageHref(state.data.overviewPath);
  const index = document.querySelector('#side-index');
  index.hidden = !state.data.indexPath;
  if (state.data.indexPath) index.href = pageHref(state.data.indexPath);
  document.querySelector('#vault-status').textContent = state.data.dailyWritable ? '日报写入已启用' : '默认只读';
}

function sectionHeader(eyebrow, title, description = '') {
  return `<div class="page-heading"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div></div>`;
}

function projectCard(project, compact = false) {
  const digest = project.digest;
  const summary = digest.goal || digest.progress[0] || '打开项目查看详细记录';
  return `<a class="project-card ${compact ? 'compact' : ''}" href="${projectHref(project.path)}"><div class="card-top"><span class="type-pill">项目</span><span class="card-date">记录至 ${formatDate(digest.progressDate || project.date)}</span></div><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(summary)}</p><div class="card-bottom"><span>${digest.action.length ? '有后续记录' : '查看进展'}</span><span class="arrow">↗</span></div></a>`;
}

function candidateRow(project, index = 0) {
  const text = project.digest.action[index];
  if (!text) return '';
  const evidence = project.digest.actionEvidence?.[index];
  return `<div class="candidate-row"><div class="candidate-icon">↗</div><div class="candidate-body"><a class="candidate-title" href="${projectHref(project.path)}">${escapeHtml(project.title)}</a><p>${escapeHtml(text)}</p>${evidenceLink(evidence)}</div><div class="candidate-actions">${state.data.dailyWritable && state.data.today.exists ? priorities().map(({ priority, label }) => `<button type="button" data-action="plan" data-project="${escapeAttr(project.path)}" data-index="${index}" data-priority="${priority}" aria-label="采纳为 ${escapeAttr(label)}">${escapeHtml(label)}</button>`).join('') : ''}</div></div>`;
}

function renderToday() {
  const { today, projects, pageCounts, unindexed } = state.data;
  if (!state.data.dailyWritable) {
    const indexReview = state.data.indexPath ? `<i></i><a href="#/unindexed"><strong>${unindexed.length}</strong> 篇未列入索引 ↗</a>` : '';
    main.innerHTML = `${sectionHeader('YOUR LIBRARY', '从已有 Wiki 看清项目进展', '查看带日期的摘要，打开原文核对依据。当前以只读模式运行。')}
      <div class="overview-strip"><span><strong>${projects.length}</strong> 个项目页面</span><i></i><span><strong>${Object.values(pageCounts).reduce((a, b) => a + b, 0)}</strong> 篇 Markdown 页面</span>${indexReview}</div>
      <section class="section-block"><div class="section-title"><div><span class="eyebrow">PROJECTS</span><h2>项目记录</h2><p>摘要提供原文入口；核对后再决定今天要做什么。</p></div><a href="#/projects">浏览全部项目 ↗</a></div><div class="project-grid">${projects.length ? projects.slice(0, 6).map(project => projectCard(project, true)).join('') : '<div class="empty-inline">如需项目视图，请在页面 frontmatter 中设置 type: project，或放入 projects/ 目录。</div>'}</div></section>
      <section class="section-block"><div class="section-title"><div><span class="eyebrow">RECENT NOTES</span><h2>最近的笔记</h2></div><a href="#/search">搜索全部内容 ↗</a></div><div class="recent-grid">${state.data.recent.slice(0, 8).map(page => `<a class="recent-card" href="${pageHref(page.path)}"><span class="type-pill">${typeLabels[page.type] || '页面'}</span><h3>${escapeHtml(page.title)}</h3><small>${formatDate(page.date)}</small><span class="arrow">↗</span></a>`).join('') || '<div class="empty-inline">资料库中还没有 Markdown 页面。</div>'}</div></section>`;
    return;
  }
  const weeklyPlan = state.data.latestWeeklyPlan;
  const plans = priorities().map(({ priority, label }) => {
    const plan = today.plans.find(item => item.priority === priority);
    return `<div class="plan-row"><span class="priority">${escapeHtml(label)}</span><span class="plan-text ${plan?.text ? '' : 'muted'}">${plan?.text ? escapeHtml(plan.text) : '尚未安排，选取下方项目记录后加入'}</span>${plan?.text ? '<span class="plan-mark">已安排</span>' : ''}</div>`;
  }).join('');
  const candidates = projects.filter(project => project.digest.action.length).slice(0, 5);
  const records = today.records.length ? today.records.slice(-4).reverse().map(record => `<div class="record-row"><span>${escapeHtml(record.time)}</span><p>${escapeHtml(record.text)}</p><small>${escapeHtml(record.tag)}</small></div>`).join('') : '<div class="empty-inline">暂无记录。开始工作后可随手记下一条进展。</div>';
  main.innerHTML = `${sectionHeader('YOUR WORKSPACE', '从已有记录安排今天', '先打开依据核对，再手动采纳后续事项，并把实际进展记入日报。')}
    <div class="overview-strip"><span><strong>${projects.length}</strong> 个项目页面</span><i></i><span><strong>${Object.values(pageCounts).reduce((a, b) => a + b, 0)}</strong> 篇 Wiki 页面</span><i></i><a href="#/unindexed"><strong>${unindexed.length}</strong> 篇尚未纳入根索引 ↗</a></div>
    <div class="today-grid"><section class="panel plan-panel"><div class="panel-title"><div><span class="eyebrow">01 / FOCUS</span><h2>${escapeHtml(state.data.dailyFormat.planHeading)}</h2></div><span class="panel-date">${formatDate(today.date)}</span></div>${today.exists ? `<div class="plan-list">${plans}</div><a class="text-link" href="${pageHref(today.path)}">查看今日日报 ↗</a>` : `<div class="empty-plan"><div class="empty-icon">◌</div><h3>今天还没有日报</h3><p>从现有模板建立空白日报，然后手动选取任务。</p><button class="primary-button" data-action="init">初始化今日日报 <span>↗</span></button></div>`}</section>
    <section class="panel capture-panel"><div class="panel-title"><div><span class="eyebrow">02 / CAPTURE</span><h2>随手记录</h2></div><span class="small-badge">写入 ${escapeHtml(state.data.dailyDir)}/</span></div><form id="capture-form"><label for="capture-text">今天推进了什么？</label><textarea id="capture-text" name="text" maxlength="400" placeholder="一句话记录具体进展或卡点…" ${today.exists ? '' : 'disabled'} required></textarea><div class="form-row"><select name="projectPath" aria-label="关联项目" ${today.exists ? '' : 'disabled'} required><option value="">选择关联项目</option>${projects.map(project => `<option value="${escapeAttr(project.path)}">${escapeHtml(project.title)}</option>`).join('')}</select><button type="submit" ${today.exists ? '' : 'disabled'}>记录 ↗</button></div></form><div class="recent-records"><span class="mini-label">${escapeHtml(state.data.dailyFormat.timelineHeading)}</span>${records}</div></section></div>
    ${weeklyPlan ? `<section class="section-block"><div class="section-title"><div><span class="eyebrow">LATEST WEEKLY NOTE</span><h2>最近周报的下周计划</h2><p>记录于 ${formatDate(weeklyPlan.date)}，仅作回看与核对。</p></div><a href="${pageHref(weeklyPlan.path, weeklyPlan.heading, weeklyPlan.line)}">查看周报原文 ↗</a></div><div class="weekly-plan">${weeklyPlan.items.map((item, index) => `<div><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(item)}</p></div>`).join('')}</div></section>` : ''}
    <section class="section-block"><div class="section-title"><div><span class="eyebrow">FROM YOUR PROJECT NOTES</span><h2>项目页中的后续记录</h2><p>部分记录早于最近周报。请核对日期，再决定是否加入今天。</p></div><a href="#/projects">浏览全部项目 ↗</a></div><div class="candidate-list">${candidates.length ? candidates.map(project => candidateRow(project)).join('') : '<div class="empty-inline">项目页尚未记录下一步。</div>'}</div></section>
    <section class="section-block"><div class="section-title"><div><span class="eyebrow">QUICK ACCESS</span><h2>最近的知识记录</h2></div><a href="#/search">搜索全部内容 ↗</a></div><div class="recent-grid">${state.data.recent.slice(0, 4).map(page => `<a class="recent-card" href="${pageHref(page.path)}"><span class="type-pill">${typeLabels[page.type] || '页面'}</span><h3>${escapeHtml(page.title)}</h3><small>${formatDate(page.date)}</small><span class="arrow">↗</span></a>`).join('')}</div></section>`;
}

function renderProjects() {
  const projects = state.data.projects;
  main.innerHTML = `${sectionHeader('PROJECTS', '项目脉络', '按最近记录排序。进展和后续事项均保留原文日期，供你核对。')}
    <div class="projects-tools"><span>共 ${projects.length} 个项目</span><input id="project-filter" type="search" placeholder="筛选项目名称…" aria-label="筛选项目" /></div>
    <div class="project-grid" id="project-grid">${projects.map(project => projectCard(project)).join('')}</div>`;
}

function renderProject(path) {
  const project = state.data.projects.find(item => item.path === path);
  if (!project) return renderNotFound();
  const digest = project.digest;
  const progress = digest.progress.length
    ? `<ul class="detail-list">${digest.progress.map((item, index) => `<li>${escapeHtml(item)}<div>${evidenceLink(digest.progressEvidence?.[index])}</div></li>`).join('')}</ul>`
    : '<p class="muted">项目页暂无可提取的进展段落。</p>';
  const actions = digest.action.length
    ? digest.action.map((item, index) => `<div class="action-item"><p>${escapeHtml(item)}</p>${evidenceLink(digest.actionEvidence?.[index])}${state.data.dailyWritable && state.data.today.exists ? `<div class="candidate-actions">${priorities().map(({ priority, label }) => `<button type="button" data-action="plan" data-project="${escapeAttr(project.path)}" data-index="${index}" data-priority="${priority}">采纳为 ${escapeHtml(label)}</button>`).join('')}</div>` : ''}</div>`).join('')
    : '<p class="muted">项目页暂无可提取的后续事项。</p>';
  main.innerHTML = `<div class="back-row"><a href="#/projects">← 全部项目</a><span> / ${escapeHtml(project.id)}</span></div>
    <div class="project-hero"><div class="hero-meta"><span class="type-pill">项目</span><span>进展记录至 ${formatDate(digest.progressDate || project.date)}</span></div><h1>${escapeHtml(project.title)}</h1><p>${escapeHtml(digest.goal || '项目目标请查看原文。')}</p>${digest.goalEvidence ? evidenceLink(digest.goalEvidence) : ''}<div><a class="primary-button as-link" href="${pageHref(project.path)}">阅读项目原文 <span>↗</span></a></div></div>
    <div class="detail-grid"><section class="panel detail-panel"><div class="panel-title"><div><span class="eyebrow">RECENT RECORD</span><h2>最近进展</h2></div><span class="panel-date">${formatDate(digest.progressDate)}</span></div>${progress}</section>
    <section class="panel detail-panel"><div class="panel-title"><div><span class="eyebrow">NEXT IN DOCUMENT</span><h2>文档中的后续事项</h2></div><span class="panel-date">${formatDate(digest.actionDate)}</span></div>${actions}${state.data.dailyWritable && !state.data.today.exists ? '<p class="helper-text">在「今日」初始化日报后，可选取一项加入计划。</p>' : ''}</section></div>
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

function setActive(section) {
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === section));
  document.querySelector('#breadcrumb-current').textContent = ({ today: '首页', projects: '项目', search: '知识搜索', page: '原文', project: '项目详情', unindexed: '索引待补' })[section] || '工作台';
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
  if (action === 'jump') {
    [...document.querySelectorAll('.markdown-body [data-heading]')].find(element => element.dataset.heading === control.dataset.heading)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'plan') {
    const project = state.data.projects.find(item => item.path === control.dataset.project);
    const index = Number(control.dataset.index);
    const text = project?.digest.action[index];
    if (!text) return notice('项目记录已变化，请刷新页面', true);
    const evidence = project.digest.actionEvidence?.[index];
    if (!evidence) return notice('来源未定位，请刷新页面后重试', true);
    const existing = state.data.today.plans.find(plan => plan.priority === Number(control.dataset.priority));
    const label = state.data.dailyFormat.priorityLabels[Number(control.dataset.priority) - 1];
    const preview = [`采纳为 ${label} → ${state.data.today.path}`, `任务：${text}`, `来源：${evidenceLabel(evidence)}`];
    if (existing?.text) preview.push(`将覆盖：${existing.text}`);
    if (!confirm(preview.join('\n'))) return;
    try {
      const { today } = await api('/api/daily', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ action: 'plan', projectPath: project.path, priority: Number(control.dataset.priority), text, sourceLine: evidence.line, replace: Boolean(existing?.text) }) });
      state.data.today = today; renderRoute(); notice(`已加入今日 ${label}`);
    } catch (error) { notice(error.message, true); }
  }
  if (action === 'init') {
    try {
      const { today } = await api('/api/daily', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify({ action: 'init' }) });
      state.data.today = today; renderRoute(); notice('今日日报已创建，可以选择任务和记录进展');
    } catch (error) { notice(error.message, true); }
  }
});
main.addEventListener('submit', async event => {
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
  if (event.target.id !== 'project-filter') return;
  const query = event.target.value.trim().toLocaleLowerCase();
  document.querySelector('#project-grid').innerHTML = state.data.projects.filter(project => `${project.title} ${project.id}`.toLocaleLowerCase().includes(query)).map(project => projectCard(project)).join('') || '<div class="empty-inline">没有匹配的项目。</div>';
});

refresh().then(renderRoute).catch(error => { main.innerHTML = `<div class="error-state">无法读取 Wiki：${escapeHtml(error.message)}</div>`; });

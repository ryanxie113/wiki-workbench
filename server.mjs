import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, readAllowedFile, searchLibrary, safeVaultPath, parsePage, availableRepoFile, availableAssetFile } from './lib/wiki.mjs';
import { zonedNow, parseToday, updateToday } from './lib/daily.mjs';
import { resolveConfig } from './lib/config.mjs';
import { hostAllowed, securityHeaders } from './lib/http.mjs';
import { renderMarkdownPage } from './lib/render.mjs';
import { buildActionInbox } from './lib/actions.mjs';
import { createAihotClient, validDailyDate } from './lib/aihot.mjs';
import { normalizeXHandle, xEmbedHtml, xEmbedSecurityHeaders } from './lib/x-embed.mjs';
import { chooseVaultFolder, inspectConnection } from './lib/connection.mjs';
import { connectionArguments, readConnection, saveConnection } from './lib/connection-store.mjs';
import { createFeedClient } from './lib/feeds.mjs';
import { readOutcomes, appendOutcome, replaceOutcomes } from './lib/action-outcomes.mjs';
import { readWorkspaceState, writeWorkspaceState } from './lib/workspace-state.mjs';
import { buildWeeklyReview } from './lib/weekly-review.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const startupArgs = process.argv.slice(2);
const startupPinned = startupArgs.includes('--vault') || Boolean(process.env.WIKI_WORKBENCH_VAULT);
const savedArgs = startupPinned ? null : connectionArguments(await readConnection());
const config = await resolveConfig(savedArgs ? [...savedArgs, ...startupArgs] : startupArgs, process.env, appDir).catch(async error => {
  if (savedArgs) {
    console.warn(`上次连接无法恢复：${error.message}；改用示例资料库`);
    return resolveConfig(startupArgs, process.env, appDir);
  }
  console.error(error.message);
  process.exit(1);
});
if (config.help) {
  console.log(config.help);
  process.exit(0);
}
const port = config.port;
const host = '127.0.0.1';
let active = { config, root: config.vault, snapshot: null, refreshAfter: 0, pendingLibrary: null };
let connectionPreview = null;
const aihot = createAihotClient();
const feeds = createFeedClient();

function librarySnapshot(session, force = false) {
  if (force && session.pendingLibrary) return session.pendingLibrary.then(() => librarySnapshot(session, true));
  if (!force && session.snapshot && Date.now() < session.refreshAfter) return Promise.resolve(session.snapshot);
  if (!session.pendingLibrary) {
    session.pendingLibrary = loadLibrary(session.root, session.config, session.snapshot).then(library => {
      session.snapshot = library;
      session.refreshAfter = Date.now() + 1500;
      return library;
    }).finally(() => { session.pendingLibrary = null; });
  }
  return session.pendingLibrary;
}

function json(response, status, data) {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function pageCard(page) {
  return {
    path: page.path, id: page.id, title: page.title, type: page.type,
    date: page.type === 'project' ? page.digest.progressDate || '' : page.attributes.updated || page.attributes.created || '',
    confidence: page.attributes.confidence || '', tags: page.attributes.tags || [],
    digest: page.digest || null
  };
}

async function requestBody(request, maxLength = 16_000) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json' || request.headers['x-workbench-request'] !== '1') {
    throw new Error('请求格式不正确');
  }
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > maxLength) throw new Error('请求内容过长');
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('JSON 格式不正确'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('请求内容必须是 JSON 对象');
  return payload;
}

async function serve(request, response) {
  if (!hostAllowed(request.headers.host, port)) return json(response, 403, { error: '请求主机不正确' });
  const url = new URL(request.url, `http://${host}:${port}`);
  const session = active;
  const { config, root } = session;
  const vaultId = createHash('sha256').update(root).digest('hex').slice(0, 16);
  if (request.method === 'GET' && url.pathname === '/api/workspace-state/export') {
    const state = await readWorkspaceState(vaultId) || { version: 1, vaultId, updatedAt: '', data: {} };
    response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="wiki-workbench-${vaultId}.json"`, 'Cache-Control': 'no-store' });
    return response.end(JSON.stringify({ ...state, vaultPath: root, actionOutcomes: await readOutcomes(vaultId) }, null, 2));
  }
  if (request.method === 'POST' && url.pathname === '/api/workspace-state') {
    const origin = request.headers.origin;
    if (origin && ![`http://${host}:${port}`, `http://localhost:${port}`].includes(origin)) return json(response, 403, { error: '请求来源不正确' });
    try {
      const payload = await requestBody(request, 1_000_000);
      const updates = payload.import === true ? payload.data : { [payload.section]: payload.value };
      if (payload.import === true && payload.version !== 1) throw new Error('备份版本不兼容');
      if (payload.import === true && (!updates || typeof updates !== 'object' || Array.isArray(updates))) throw new Error('备份内容不正确');
      const saved = await writeWorkspaceState(vaultId, updates, { replace: payload.import === true });
      if (payload.import === true && payload.actionOutcomes !== undefined) await replaceOutcomes(vaultId, payload.actionOutcomes);
      return json(response, 200, { workspaceState: saved });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/feeds/read') {
    const origin = request.headers.origin;
    if (origin && ![`http://${host}:${port}`, `http://localhost:${port}`].includes(origin)) return json(response, 403, { error: '请求来源不正确' });
    const payload = await requestBody(request);
    try { return json(response, 200, await feeds.get(payload.url, payload.refresh === true)); }
    catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/connection/')) {
    const origin = request.headers.origin;
    if (origin && ![`http://${host}:${port}`, `http://localhost:${port}`].includes(origin)) return json(response, 403, { error: '请求来源不正确' });
    const payload = await requestBody(request);
    if (url.pathname === '/api/connection/choose') {
      try { return json(response, 200, { path: await chooseVaultFolder() }); }
      catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (url.pathname === '/api/connection/inspect') {
      connectionPreview = null;
      try {
        const result = await inspectConnection(payload, appDir);
        const token = randomUUID();
        connectionPreview = { ...result, token, expiresAt: Date.now() + 10 * 60_000 };
        return json(response, 200, { ...result.preview, token });
      } catch (error) { return json(response, 400, { error: error.message }); }
    }
    if (url.pathname === '/api/connection/activate') {
      if (typeof payload.token !== 'string' || !connectionPreview || payload.token !== connectionPreview.token || Date.now() > connectionPreview.expiresAt) {
        return json(response, 400, { error: '预检已失效，请重新检查文件夹' });
      }
      const prepared = connectionPreview;
      connectionPreview = null;
      if (!startupPinned) {
        try { await saveConnection(prepared.preview); }
        catch (error) { return json(response, 500, { error: `连接设置无法保存：${error.message}` }); }
      }
      active = { config: prepared.config, root: prepared.config.vault, snapshot: prepared.library, refreshAfter: 0, pendingLibrary: null };
      return json(response, 200, { path: active.root });
    }
    return json(response, 404, { error: '页面不存在' });
  }
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const library = await librarySnapshot(session, url.searchParams.get('refresh') === '1');
    const todayDate = zonedNow(config.timeZone).date;
    const todayText = await readAllowedFile(root, `${config.dailyDir}/${todayDate}.md`, config);
    const projects = library.pages.filter(page => page.type === 'project').map(pageCard).sort((a, b) => b.digest.progressDate.localeCompare(a.digest.progressDate));
    const pageCounts = Object.fromEntries(['project', 'concept', 'entity', 'source', 'insight', 'personal', 'other'].map(type => [type, library.pages.filter(page => page.type === type).length]));
    const recent = library.pages.filter(page => !['daily', 'index'].includes(page.type)).map(pageCard).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    const indexPath = library.byPath.has(config.indexPath) ? config.indexPath : null;
    const overviewPaths = library.byId.get('overview') || [];
    const overviewPath = overviewPaths.length === 1 ? overviewPaths[0] : null;
    const workspaceState = await readWorkspaceState(vaultId);
    const actions = buildActionInbox(library, config, workspaceState?.data.inbox?.sourceActions || []);
    const actionOutcomes = await readOutcomes(vaultId);
    return json(response, 200, {
      today: parseToday(todayText, todayDate, config.dailyDir, config.dailyFormat), projects, recent, pageCounts,
      actions, actionOutcomes, workspaceState,
      weeklyReview: buildWeeklyReview(library, config, todayDate, actions, actionOutcomes),
      vault: {
        path: root, id: vaultId,
        demo: root === path.join(appDir, 'examples/demo-vault'),
        contentDir: config.contentDir || '', pageCount: library.pages.length
      },
      unindexed: library.unindexed,
      latestWeeklyPlan: library.latestWeeklyPlan, indexPath, overviewPath,
      dailyWritable: config.writeDaily, dailyDir: config.dailyDir, connectionPersistent: !startupPinned,
      dailyFormat: config.dailyFormat
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/actions/outcome') {
    const origin = request.headers.origin;
    if (origin && ![`http://${host}:${port}`, `http://localhost:${port}`].includes(origin)) return json(response, 403, { error: '请求来源不正确' });
    const payload = await requestBody(request);
    const library = await librarySnapshot(session, true);
    const workspaceState = await readWorkspaceState(vaultId);
    const candidate = buildActionInbox(library, config, workspaceState?.data.inbox?.sourceActions || []).find(item => item.id === payload.id);
    if (!candidate?.adoption || !['planned', 'completed'].includes(candidate.status)) return json(response, 400, { error: '该事项尚未采纳或来源已变化' });
    if (candidate.status === 'completed' && payload.status !== 'completed') return json(response, 400, { error: '日报已勾选完成，请先核对日报状态' });
    const syncDaily = payload.syncDaily === true;
    const currentDay = zonedNow(config.timeZone).date;
    if (syncDaily && (payload.status !== 'completed' || !config.writeDaily
      || candidate.adoption.date !== currentDay || candidate.adoption.path !== `${config.dailyDir || 'daily'}/${currentDay}.md`)) {
      return json(response, 400, { error: '只能同步勾选已启用写入的今日日报计划' });
    }
    try {
      const event = await appendOutcome(vaultId, candidate, payload.status, payload.note);
      if (!syncDaily) return json(response, 200, { event, synced: false });
      try {
        await updateToday(root, 'complete', {
          priority: candidate.adoption.priority, projectPath: candidate.projectPath || candidate.adoption.projectPath,
          text: candidate.text
        }, library, config);
        session.refreshAfter = 0;
        return json(response, 200, { event, synced: true });
      } catch (error) {
        session.refreshAfter = 0;
        return json(response, 200, { event, synced: false, syncError: error.message });
      }
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/search') {
    const library = await librarySnapshot(session);
    const query = (url.searchParams.get('q') || '').slice(0, 200);
    const type = url.searchParams.get('type') || 'all';
    return json(response, 200, { results: searchLibrary(library, query, type) });
  }
  if (request.method === 'GET' && url.pathname === '/api/aihot/dailies') {
    try {
      const result = await aihot.getIndex(url.searchParams.get('refresh') === '1');
      return json(response, 200, { items: result.data.items, stale: result.stale, fetchedAt: result.fetchedAt });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/aihot/daily') {
    const date = url.searchParams.get('date');
    if (date !== null && !validDailyDate(date)) return json(response, 400, { error: '日报日期必须是 YYYY-MM-DD' });
    try {
      const result = await aihot.getDaily(date, url.searchParams.get('refresh') === '1');
      return json(response, 200, { report: result.data, stale: result.stale, fetchedAt: result.fetchedAt });
    } catch (error) { return json(response, 502, { error: error.message }); }
  }
  if (request.method === 'GET' && url.pathname === '/x-embed') {
    const handle = normalizeXHandle(url.searchParams.get('handle'));
    if (!handle) return json(response, 400, { error: '无效的 X 账号' });
    response.writeHead(200, { ...xEmbedSecurityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
    return response.end(xEmbedHtml(handle));
  }
  if (request.method === 'GET' && url.pathname === '/api/asset') {
    const relative = url.searchParams.get('path');
    const filename = await availableAssetFile(root, relative, config);
    if (!filename) return json(response, 404, { error: '图片不存在或无法读取' });
    const extension = path.extname(relative).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' }[extension];
    const data = await readFile(filename);
    response.writeHead(200, { ...securityHeaders, 'Content-Type': mime, 'Cache-Control': 'no-store' });
    return response.end(data);
  }
  if (request.method === 'GET' && url.pathname === '/api/page') {
    const relative = url.searchParams.get('path');
    if (!safeVaultPath(relative)) return json(response, 400, { error: '无效的文件路径' });
    const library = await librarySnapshot(session);
    const cited = library.pages.some(item => item.attributes.sources?.includes(relative));
    if (!library.byPath.has(relative) && !cited) return json(response, 404, { error: '文件未收录或未被页面引用' });
    const markdown = await readAllowedFile(root, relative, config);
    if (markdown === null) return json(response, 404, { error: '文件不存在或无法读取' });
    const page = parsePage(relative, markdown, config);
    page.html = renderMarkdownPage(page, library);
    page.sourceAvailability = await Promise.all((page.attributes.sources || []).slice(0, 20).map(async source => {
      const kind = /^https?:\/\//i.test(source) ? 'external' : source.startsWith('/') ? 'absolute' : 'relative';
      return {
        source, kind,
        exists: kind === 'relative' && Boolean(await availableRepoFile(root, source, config)),
        readable: /\.(?:md|txt|json|jsonl|yaml|yml|py|csv|tsv)$/i.test(source)
      };
    }));
    if (page.type === 'project') {
      page.digest = library.byPath.get(relative)?.digest || null;
    }
    return json(response, 200, { page });
  }
  if (request.method === 'POST' && url.pathname === '/api/daily') {
    if (!config.writeDaily) return json(response, 403, { error: '日报写入未启用' });
    const origin = request.headers.origin;
    if (origin && ![`http://${host}:${port}`, `http://localhost:${port}`].includes(origin)) return json(response, 403, { error: '请求来源不正确' });
    const payload = await requestBody(request);
    const library = await librarySnapshot(session, true);
    const workspaceState = await readWorkspaceState(vaultId);
    const today = await updateToday(root, payload.action, payload, library, { ...config, sourceActions: workspaceState?.data.inbox?.sourceActions || [] });
    session.refreshAfter = 0;
    return json(response, 200, { today });
  }
  if (request.method !== 'GET') return json(response, 405, { error: '不支持的请求' });
  const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
  const asset = assets[url.pathname];
  if (!asset) return json(response, 404, { error: '页面不存在' });
  const data = await readFile(path.join(appDir, 'public', asset[0]));
  response.writeHead(200, { ...securityHeaders, 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
  response.end(data);
}

const server = http.createServer((request, response) => {
  serve(request, response).catch(error => {
    const expected = /^(内容|请选择|找不到|项目记录|请先|今日计划|今日日报|未知操作|请求|日报)/.test(error.message);
    if (!expected) console.error(error);
    json(response, expected ? 400 : 500, { error: expected ? error.message : '工作台暂时无法读取数据' });
  });
});

server.on('error', error => {
  console.error(`无法启动本地服务：${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Wiki 工作台已启动：http://${host}:${port}（资料库：${active.root}，${config.writeDaily ? '日报可写' : '只读'}）`));

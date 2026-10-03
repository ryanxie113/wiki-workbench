import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, readAllowedFile, searchLibrary, safeVaultPath, parsePage, availableRepoFile, availableAssetFile } from './lib/wiki.mjs';
import { zonedNow, parseToday, updateToday } from './lib/daily.mjs';
import { resolveConfig } from './lib/config.mjs';
import { hostAllowed, securityHeaders } from './lib/http.mjs';
import { renderMarkdownPage } from './lib/render.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const config = await resolveConfig(process.argv.slice(2), process.env, appDir).catch(error => {
  console.error(error.message);
  process.exit(1);
});
if (config.help) {
  console.log(config.help);
  process.exit(0);
}
const root = config.vault;
const port = config.port;
const host = '127.0.0.1';
let snapshot = null;
let refreshAfter = 0;
let pendingLibrary = null;

function librarySnapshot() {
  if (snapshot && Date.now() < refreshAfter) return Promise.resolve(snapshot);
  if (!pendingLibrary) {
    pendingLibrary = loadLibrary(root, config, snapshot).then(library => {
      snapshot = library;
      refreshAfter = Date.now() + 1500;
      return library;
    }).finally(() => { pendingLibrary = null; });
  }
  return pendingLibrary;
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

async function requestBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json' || request.headers['x-workbench-request'] !== '1') {
    throw new Error('请求格式不正确');
  }
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16_000) throw new Error('请求内容过长');
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('JSON 格式不正确'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('请求内容必须是 JSON 对象');
  return payload;
}

async function serve(request, response) {
  if (!hostAllowed(request.headers.host, port)) return json(response, 403, { error: '请求主机不正确' });
  const url = new URL(request.url, `http://${host}:${port}`);
  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const library = await librarySnapshot();
    const todayDate = zonedNow(config.timeZone).date;
    const todayText = await readAllowedFile(root, `${config.dailyDir}/${todayDate}.md`, config);
    const projects = library.pages.filter(page => page.type === 'project').map(pageCard).sort((a, b) => b.digest.progressDate.localeCompare(a.digest.progressDate));
    const pageCounts = Object.fromEntries(['project', 'concept', 'entity', 'source', 'insight', 'personal', 'other'].map(type => [type, library.pages.filter(page => page.type === type).length]));
    const recent = library.pages.filter(page => !['daily', 'index'].includes(page.type)).map(pageCard).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
    const indexPath = library.byPath.has(config.indexPath) ? config.indexPath : null;
    const overviewPaths = library.byId.get('overview') || [];
    const overviewPath = overviewPaths.length === 1 ? overviewPaths[0] : null;
    return json(response, 200, {
      today: parseToday(todayText, todayDate, config.dailyDir, config.dailyFormat), projects, recent, pageCounts,
      unindexed: library.unindexed,
      latestWeeklyPlan: library.latestWeeklyPlan, indexPath, overviewPath,
      dailyWritable: config.writeDaily, dailyDir: config.dailyDir,
      dailyFormat: config.dailyFormat
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/search') {
    const library = await librarySnapshot();
    const query = (url.searchParams.get('q') || '').slice(0, 200);
    const type = url.searchParams.get('type') || 'all';
    return json(response, 200, { results: searchLibrary(library, query, type) });
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
    const library = await librarySnapshot();
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
    const library = await librarySnapshot();
    const today = await updateToday(root, payload.action, payload, library, config);
    refreshAfter = 0;
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
server.listen(port, host, () => console.log(`Wiki 工作台已启动：http://${host}:${port}（资料库：${root}，${config.writeDaily ? '日报可写' : '只读'}）`));

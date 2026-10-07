import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chooseVaultFolder, inspectConnection } from '../lib/connection.mjs';
import { connectionArguments, readConnection, saveConnection } from '../lib/connection-store.mjs';
import { zonedNow } from '../lib/daily.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('接入预检识别 wiki 子目录、项目和只读范围，不修改原文件', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'workbench-connect-'));
  try {
    await mkdir(path.join(folder, 'wiki', 'projects'), { recursive: true });
    const original = '# Sample project\n\n## Next steps\n- Ship it\n';
    await writeFile(path.join(folder, 'wiki/projects/sample.md'), original);
    const { config, preview } = await inspectConnection({ path: folder }, appDir);
    assert.equal(config.contentDir, 'wiki');
    assert.equal(preview.pageCount, 1);
    assert.equal(preview.projectCount, 1);
    assert.equal(preview.writeDaily, false);
    assert.equal(preview.projects[0].path, 'wiki/projects/sample.md');
    assert.equal(await readFile(path.join(folder, 'wiki/projects/sample.md'), 'utf8'), original);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('接入预检拒绝无效路径和不合格日报模板', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'workbench-connect-'));
  try {
    await writeFile(path.join(folder, 'note.md'), '# Note\n');
    await assert.rejects(inspectConnection({ path: 'relative/folder' }, appDir), /完整路径/);
    await assert.rejects(inspectConnection({ path: folder, writeDaily: true }, appDir), /日报写入需要/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('连接设置可保存并转成重启参数', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'workbench-connection-store-'));
  try {
    const file = path.join(folder, 'settings', 'connection.json');
    const preview = { path: folder, contentDir: 'wiki', dailyDir: 'journal', writeDaily: true };
    await saveConnection(preview, file);
    assert.deepEqual(await readConnection(file), preview);
    assert.deepEqual(connectionArguments(await readConnection(file)), ['--vault', folder, '--content-dir', 'wiki', '--daily-dir', 'journal', '--write-daily']);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('本机文件夹选择器只接受绝对路径', async () => {
  const result = await chooseVaultFolder('darwin', async (command, args) => {
    assert.equal(command, 'osascript');
    assert.match(args[1], /choose folder/);
    return { stdout: '/Users/example/notes/\n' };
  });
  assert.equal(result, '/Users/example/notes/');
  await assert.rejects(chooseVaultFolder('linux', async () => ({ stdout: 'relative\n' })), /未选择文件夹/);
});

async function openPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(port, configHome, args = []) {
  const child = spawn(process.execPath, ['server.mjs', '--port', String(port), ...args], {
    cwd: appDir, env: { ...process.env, XDG_CONFIG_HOME: configHome, WIKI_WORKBENCH_VAULT: '' }, stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error('测试服务提前退出');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
      if (response.ok) return child;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('测试服务未启动');
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

test('连接 API 经预检确认后切换资料库，并在默认启动时恢复', async () => {
  const configHome = await mkdtemp(path.join(os.tmpdir(), 'workbench-config-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'workbench-switch-'));
  const port = await openPort();
  let child;
  try {
    await writeFile(path.join(vault, 'only-here.md'), '# Unique local note\n');
    child = await startServer(port, configHome);
    const base = `http://127.0.0.1:${port}`;
    const post = (endpoint, body, origin = base) => fetch(`${base}/api/connection/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1', Origin: origin }, body: JSON.stringify(body)
    });
    const blocked = await post('inspect', { path: vault }, 'https://example.com');
    assert.equal(blocked.status, 403);
    const inspected = await post('inspect', { path: vault });
    assert.equal(inspected.status, 200);
    const preview = await inspected.json();
    assert.equal(preview.pageCount, 1);
    assert.equal((await post('activate', { token: 'wrong' })).status, 400);
    assert.equal((await post('activate', { token: preview.token })).status, 200);
    const changed = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(changed.vault.path, await realpath(vault));
    assert.equal(changed.vault.pageCount, 1);
    assert.equal(changed.dailyWritable, false);
    await stopServer(child);
    child = await startServer(port, configHome);
    const restored = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(restored.vault.path, await realpath(vault));
  } finally {
    if (child) await stopServer(child);
    await rm(vault, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

test('结果接口可在确认后勾选今日日报，并从日报识别最终完成状态', async () => {
  const configHome = await mkdtemp(path.join(os.tmpdir(), 'workbench-outcome-config-'));
  const vault = await mkdtemp(path.join(os.tmpdir(), 'workbench-outcome-vault-'));
  const port = await openPort();
  let child;
  try {
    await mkdir(path.join(vault, 'projects'));
    await mkdir(path.join(vault, 'daily'));
    await writeFile(path.join(vault, 'projects/demo.md'), '# Demo\n\n## Next steps 2026-10-01\n- Review benchmark\n');
    await writeFile(path.join(vault, 'daily/_template.md'), await readFile(path.join(appDir, 'examples/demo-vault/daily/_template.md'), 'utf8'));
    child = await startServer(port, configHome, ['--vault', vault, '--write-daily', '--time-zone', 'UTC']);
    const base = `http://127.0.0.1:${port}`;
    const post = (endpoint, body) => fetch(`${base}${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1', Origin: base }, body: JSON.stringify(body)
    });
    const initial = await (await fetch(`${base}/api/bootstrap`)).json();
    const action = initial.actions.find(item => item.text === 'Review benchmark');
    assert.equal(action.status, 'pending');
    assert.equal((await post('/api/daily', { action: 'init' })).status, 200);
    assert.equal((await post('/api/daily', { action: 'plan', projectPath: 'projects/demo.md', priority: 1,
      text: action.text, sourceLine: action.evidence.line })).status, 200);
    const planned = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(planned.actions.find(item => item.id === action.id).status, 'planned');
    const response = await post('/api/actions/outcome', { id: action.id, status: 'completed', note: '已验收', syncDaily: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).synced, true);
    const markdown = await readFile(path.join(vault, `daily/${zonedNow('UTC').date}.md`), 'utf8');
    assert.match(markdown, /- \[x\] P1: Review benchmark \[\[projects\/demo\]\]/);
    const finished = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(finished.actions.find(item => item.id === action.id).status, 'completed');
    assert.equal(finished.actionOutcomes.at(-1).note, '已验收');
  } finally {
    if (child) await stopServer(child);
    await rm(vault, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

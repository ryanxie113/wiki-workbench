import { buildActionInbox } from '../../lib/actions.mjs';
import { projectDigest, parsePage } from '../../lib/wiki.mjs';
import { normalizeProjectFormat } from '../../lib/project-format.mjs';

const MAX_MARKDOWN_BYTES = 3_000_000;
const READ_CONCURRENCY = 16;

function included(file, config) {
  if (!file.path.toLowerCase().endsWith('.md') || file.path.split('/').at(-1) === '_template.md'
    || file.stat?.size > MAX_MARKDOWN_BYTES) return false;
  const root = config.contentDir?.replace(/^\/+|\/+$/g, '') || '';
  if (!root) return true;
  const dailyDir = config.dailyDir || 'daily';
  return file.path.startsWith(`${root}/`) || file.path.startsWith(`${dailyDir}/`)
    || file.path === (config.indexPath || 'index.md');
}

async function mapLimited(items, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

export async function buildVaultSnapshot(files, readMarkdown, config = {}) {
  const format = normalizeProjectFormat(config.projectFormat);
  const selected = files.filter(file => included(file, config)).sort((a, b) => a.path.localeCompare(b.path));
  const pages = await mapLimited(selected, async file => {
    const page = parsePage(file.path, await readMarkdown(file), config);
    if (page.type === 'project') page.digest = projectDigest(page, format);
    return page;
  });
  const projects = pages.filter(page => page.type === 'project')
    .sort((a, b) => (b.digest.progressDate || b.attributes.updated || '').localeCompare(a.digest.progressDate || a.attributes.updated || '')
      || a.title.localeCompare(b.title));
  return {
    pageCount: pages.length,
    projects,
    actions: buildActionInbox({ pages }, config)
  };
}

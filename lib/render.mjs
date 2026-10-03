import path from 'node:path';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { safeVaultPath } from './wiki.mjs';

const RASTER_IMAGE = /\.(?:png|jpe?g|gif|webp|avif)$/i;
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(taskLists, { enabled: false });

function escape(value) {
  return markdown.utils.escapeHtml(String(value || ''));
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function pageHref(relative, heading = '') {
  const query = heading ? `?heading=${encodeURIComponent(heading)}` : '';
  return `#/page/${encodeURIComponent(relative)}${query}`;
}

function pathCandidate(relative) {
  const normalized = path.posix.normalize(relative);
  return safeVaultPath(normalized) ? normalized : null;
}

export function resolveWikiTarget(target, currentPath, library) {
  const name = decode(target.trim()).replace(/\.md$/i, '');
  if (!name || name.startsWith('/') || name.includes('\\')) return null;
  if (name.includes('/')) {
    const rootPath = pathCandidate(`${name}.md`);
    const nearbyPath = pathCandidate(path.posix.join(path.posix.dirname(currentPath), `${name}.md`));
    const explicitRelative = name.startsWith('./') || name.startsWith('../');
    for (const candidate of explicitRelative ? [nearbyPath] : [rootPath, nearbyPath]) {
      if (candidate && library.byPath.has(candidate)) return candidate;
    }
    if (explicitRelative) return null;
    const suffix = `/${name}.md`;
    const matches = library.pages.filter(page => page.path.endsWith(suffix));
    return matches.length === 1 ? matches[0].path : null;
  }
  const matches = library.byId.get(name) || library.byAlias?.get(name) || [];
  if (matches.length === 1) return matches[0];
  const nearby = matches.filter(candidate => path.posix.dirname(candidate) === path.posix.dirname(currentPath));
  return nearby.length === 1 ? nearby[0] : null;
}

function localPath(href, currentPath, fromVaultRoot = false) {
  const value = decode(href.split('#')[0].split('?')[0]);
  if (!value || value.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;
  if (value.startsWith('/')) return fromVaultRoot ? pathCandidate(value.slice(1)) : null;
  return pathCandidate(path.posix.join(path.posix.dirname(currentPath), value));
}

function markdownPagePath(href, currentPath, library) {
  const relative = localPath(href, currentPath, true);
  if (!relative) return null;
  const candidates = path.posix.extname(relative) ? [relative] : [relative, `${relative}.md`];
  return candidates.find(candidate => library.byPath.has(candidate)) || null;
}

function renderImage(src, alt, currentPath, wikiEmbed = false) {
  if (/^https?:\/\//i.test(src)) {
    return `<a class="external-image" href="${escape(src)}" target="_blank" rel="noopener noreferrer">查看外部图片：${escape(alt || src)} ↗</a>`;
  }
  const explicitRelative = src.startsWith('./') || src.startsWith('../');
  const rootCandidate = wikiEmbed && src.includes('/') && !explicitRelative ? pathCandidate(decode(src)) : null;
  const relative = rootCandidate || localPath(src, currentPath, true);
  if (!relative || !RASTER_IMAGE.test(relative)) return `<span class="missing-link">图片路径不可用：${escape(alt || src)}</span>`;
  return `<img src="/api/asset?path=${encodeURIComponent(relative)}" alt="${escape(alt)}" loading="lazy" decoding="async">`;
}

markdown.inline.ruler.before('link', 'wiki_link', (state, silent) => {
  const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push('wiki_link', '', 0);
    token.content = match[2];
    token.meta = { embed: Boolean(match[1]) };
  }
  state.pos += match[0].length;
  return true;
});

markdown.renderer.rules.wiki_link = (tokens, index, _options, env) => {
  const token = tokens[index];
  const [targetAndHeading, alias] = token.content.split(/\|(.+)/, 2);
  const [target, heading = ''] = targetAndHeading.split(/#(.+)/, 2);
  if (token.meta.embed && RASTER_IMAGE.test(target)) return renderImage(target, alias || target, env.pagePath, true);
  const resolved = !target && heading ? env.pagePath : resolveWikiTarget(target, env.pagePath, env.library);
  const label = escape(alias || target || heading);
  return resolved ? `<a class="wiki-link" href="${pageHref(resolved, heading)}">${label}</a>`
    : `<span class="missing-link" title="目标缺失或名称不唯一">${label}</span>`;
};

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = token.attrGet('href') || '';
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  } else if (href.startsWith('#')) {
    token.attrSet('href', pageHref(env.pagePath, decode(href.slice(1))));
  } else if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//')) {
    const relative = markdownPagePath(href, env.pagePath, env.library);
    if (relative) token.attrSet('href', pageHref(relative, decode(href.split('#')[1] || '')));
    else {
      token.attrs = (token.attrs || []).filter(([key]) => key !== 'href');
      token.attrSet('class', 'missing-link');
      token.attrSet('aria-disabled', 'true');
    }
  }
  return self.renderToken(tokens, index, options);
};

markdown.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index];
  return renderImage(token.attrGet('src') || '', token.content, env.pagePath);
};

markdown.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const heading = tokens[index + 1]?.content || '';
  token.attrSet('data-heading', heading);
  token.attrSet('data-line', String((token.map?.[0] || 0) + 1 + (env.bodyLineOffset || 0)));
  if (token.map) token.attrSet('data-line-end', String(token.map[1] + (env.bodyLineOffset || 0)));
  return self.renderToken(tokens, index, options);
};

for (const rule of ['paragraph_open', 'list_item_open']) {
  markdown.renderer.rules[rule] = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token.map) {
      token.attrSet('data-line', String(token.map[0] + 1 + (env.bodyLineOffset || 0)));
      token.attrSet('data-line-end', String(token.map[1] + (env.bodyLineOffset || 0)));
    }
    return self.renderToken(tokens, index, options);
  };
}

markdown.renderer.rules.table_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token.map) {
    token.attrSet('data-line', String(token.map[0] + 1 + (env.bodyLineOffset || 0)));
    token.attrSet('data-line-end', String(token.map[1] + (env.bodyLineOffset || 0)));
  }
  return `<div class="table-wrap">${self.renderToken(tokens, index, options)}`;
};
markdown.renderer.rules.table_close = (tokens, index, options, env, self) => `${self.renderToken(tokens, index, options)}</div>`;

export function renderMarkdownPage(page, library) {
  return markdown.render(page.body, { pagePath: page.path, bodyLineOffset: page.bodyLineOffset, library });
}

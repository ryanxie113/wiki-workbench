import { createHash } from 'node:crypto';

const embedStatusScript = "window.setTimeout(() => { if (window.parent === window) return; const timeline = document.querySelector('iframe.twitter-timeline, iframe[id^=\"twitter-widget-\"]'); if (!timeline) window.parent.postMessage({ type: 'wiki-workbench-x-embed', status: 'unavailable' }, '*'); }, 10000);";
const embedStatusHash = createHash('sha256').update(embedStatusScript).digest('base64');

export function normalizeXHandle(value) {
  const input = String(value ?? '').trim();
  const match = input.match(/^(?:@)?([A-Za-z0-9_]{1,15})$/)
    || input.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/?$/i);
  return match ? match[1].toLowerCase() : '';
}

export function xEmbedHtml(handle) {
  const name = normalizeXHandle(handle);
  if (!name) throw new Error('无效的 X 账号');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><style>html,body{margin:0;background:#fff;color:#42604f;font:13px system-ui,sans-serif}a{color:#278355}</style></head><body><a class="twitter-timeline" data-height="620" data-theme="light" data-dnt="true" href="https://x.com/${name}">在 X 查看 @${name} 的公开动态</a><script async src="https://platform.x.com/widgets.js" charset="utf-8"></script><script>${embedStatusScript}</script></body></html>`;
}

export const xEmbedSecurityHeaders = {
  'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${embedStatusHash}' https://platform.x.com https://platform.twitter.com; style-src 'unsafe-inline' https://platform.x.com https://platform.twitter.com; img-src data: https:; connect-src https://*.x.com https://*.twitter.com https://*.twimg.com; frame-src https://*.x.com https://*.twitter.com https://*.twimg.com; font-src https://*.twimg.com; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'self'`,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
};

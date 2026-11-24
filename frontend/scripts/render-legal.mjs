import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { createServer } from 'vite';

// Render the same legal components as the app so policy text has one source.
const index = await readFile('dist/index.html', 'utf8');
const styles = index.match(/<link [^>]*rel="stylesheet"[^>]*>/g)?.join('\n') ?? '';
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  for (const [path, component, title] of [
    ['privacy', 'PrivacyPage', 'Privacy Policy'],
    ['terms', 'TermsPage', 'Terms of Service'],
  ]) {
    const { default: Page } = await server.ssrLoadModule('/src/pages/' + component + '.tsx');
    const body = renderToStaticMarkup(createElement(StaticRouter, { location: '/' + path }, createElement(Page)));
    await mkdir('dist/' + path, { recursive: true });
    await writeFile('dist/' + path + '/index.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Uncle Owen</title>${styles}</head><body>${body}</body></html>`);
  }
} finally {
  await server.close();
}

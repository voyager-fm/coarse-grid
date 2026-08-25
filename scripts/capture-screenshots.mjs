/**
 * Captures README screenshots of the Coarse Grid app.
 *
 * Builds (npm run build), previews on 127.0.0.1:4173, uploads a fixture from
 * test/browser/fixtures.js, lets the default render settle, and writes:
 *   - docs/img/hero.png      (1440x900 desktop workbench with the filter result)
 *   - docs/img/controls.png  (375px-wide mobile view of the controls panel)
 *
 * Run with:  node scripts/capture-screenshots.mjs
 * Requires the preview server to already be running on 127.0.0.1:4173
 * (npm run build && npm run preview), or this script starts it itself.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createMulticolorGradientUpload, createDirectionalProbeUpload } from '../test/browser/fixtures.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const BASE_URL = 'http://127.0.0.1:4173';
const HERO_PATH = resolve(REPO_ROOT, 'docs/img/hero.png');
const CONTROLS_PATH = resolve(REPO_ROOT, 'docs/img/controls.png');

function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolvePromise(true);
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for preview server'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function uploadFixture(page, payload) {
  await page.setInputFiles('#file-input', {
    name: payload.name,
    mimeType: payload.mimeType,
    buffer: payload.buffer,
  });
  // Wait for the preview canvas to render (non-blank).
  await page.waitForFunction(() => {
    const canvas = document.getElementById('preview-canvas');
    if (!canvas) return false;
    return canvas.width > 0 && canvas.height > 0;
  });
  // Give the GPU pipeline a moment to draw the default render.
  await page.waitForTimeout(800);
}

async function main() {
  // Ensure the preview server is up (build first if dist is missing/stale).
  if (!existsSync(resolve(REPO_ROOT, 'dist/index.html'))) {
    console.log('Building production bundle…');
    const build = spawn('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    await new Promise((r, j) => build.on('exit', (code) => (code === 0 ? r() : j(new Error('build failed')))));
  }

  const server = spawn('npm', ['run', 'preview'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    detached: false,
  });

  try {
    await waitForServer(BASE_URL);
  } catch (err) {
    server.kill();
    throw err;
  }

  const browser = await chromium.launch();

  try {
    // ---- Hero: 1440x900 desktop workbench with the multicolor-gradient result ----
    const hero = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await hero.goto(BASE_URL, { waitUntil: 'networkidle' });
    await uploadFixture(hero, createMulticolorGradientUpload());
    await hero.waitForTimeout(600);
    await hero.screenshot({ path: HERO_PATH, fullPage: false });
    console.log('Wrote', HERO_PATH);
    await hero.close();

    // ---- Controls: 375px-wide mobile view of the controls panel ----
    const controls = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await controls.goto(BASE_URL, { waitUntil: 'networkidle' });
    await uploadFixture(controls, createDirectionalProbeUpload());
    // Scroll the controls panel into view and capture it.
    await controls.locator('#controls').scrollIntoViewIfNeeded();
    await controls.waitForTimeout(600);
    await controls.locator('#controls').screenshot({ path: CONTROLS_PATH });
    console.log('Wrote', CONTROLS_PATH);
    await controls.close();
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * Take screenshot of dashboard HTML
 *
 * Uses Playwright to capture full-page screenshot with Japanese font support.
 * Can capture from deployed URL or local HTML file.
 * Outputs 3 images (mobile-optimized vertical layout):
 *   - screenshot-1.png: Header + Health Status
 *   - screenshot-2.png: AI Suggestions
 *   - screenshot-3.png: Magazine Details + Calendar
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadLocalHtml(page, localHtmlPath) {
  await fs.access(localHtmlPath);
  const localUrl = `file://${localHtmlPath}`;
  console.log(`📂 ローカルHTML: ${localUrl}`);
  await page.goto(localUrl, {
    waitUntil: 'networkidle',
    timeout: 60000
  });
  return localUrl;
}

async function takeScreenshot() {
  console.log('📸 スクリーンショットを生成中...');

  let browser;
  try {
    const urlPath = path.join(__dirname, '..', 'data', 'deployed-url.txt');
    let url;
    let usedDeployedUrl = false;

    try {
      url = await fs.readFile(urlPath, 'utf-8');
      url = url.trim();
      usedDeployedUrl = true;
      url = `${url}?t=${Date.now()}`;
      console.log(`🌐 対象URL: ${url}`);
    } catch {
      console.log('⚠️ デプロイURLが見つかりません。ローカルHTMLを使用します。');
      const htmlPath = path.join(__dirname, '..', 'output', 'dashboard.html');

      try {
        await fs.access(htmlPath);
        url = `file://${htmlPath}`;
      } catch {
        console.error('❌ HTMLファイルが見つかりません');
        console.log('💡 先に npm run generate-dashboard を実行してください');
        process.exit(1);
      }
    }

    if (usedDeployedUrl && url.startsWith('http')) {
      const waitMs = Number(process.env.MAGAZINE_SURGE_CDN_WAIT_MS ?? '10000');
      if (waitMs > 0) {
        console.log(`⏳ Surge CDN 反映待ち ${waitMs}ms...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    console.log('🌐 ブラウザを起動中...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--font-render-hinting=none',
        '--lang=ja-JP'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1100, height: 2000 },
      deviceScaleFactor: 2,
      locale: 'ja-JP'
    });

    const page = await context.newPage();

    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `
        body {
          font-family:
            'Apple Color Emoji',
            'Segoe UI Emoji',
            'Noto Color Emoji',
            -apple-system,
            BlinkMacSystemFont,
            'Segoe UI',
            Roboto,
            'Helvetica Neue',
            Arial,
            'Noto Sans JP',
            'Noto Sans CJK JP',
            'Hiragino Sans',
            'Hiragino Kaku Gothic ProN',
            'メイリオ',
            Meiryo,
            sans-serif;
        }
      `;
      document.head.appendChild(style);
    });

    console.log('📄 ページを読み込み中...');
    try {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 60000
      });
      console.log('✅ ページ読み込み成功');
    } catch (error) {
      console.warn(`⚠️ デプロイURLの読み込みに失敗しました: ${error.message}`);
      console.log('🔄 ローカルHTMLにフォールバック中...');
      const htmlPath = path.join(__dirname, '..', 'output', 'dashboard.html');
      try {
        url = await loadLocalHtml(page, htmlPath);
        console.log('✅ ローカルHTMLの読み込み成功');
      } catch (localError) {
        console.error('❌ ローカルHTMLの読み込みにも失敗しました');
        throw localError;
      }
    }

    await page.waitForTimeout(2000);

    const contentHeight = await page.evaluate(() => document.body.scrollHeight);
    console.log(`📏 コンテンツ高さ: ${contentHeight}px`);
    await page.setViewportSize({ width: 1100, height: contentHeight });

    const screenshotDir = path.join(__dirname, '..', 'output');
    await fs.mkdir(screenshotDir, { recursive: true });

    let sections;
    try {
      sections = await page.evaluate(() => {
        const healthStatus = document.querySelector('.health-status');
        const aiSuggestions = document.querySelector('.ai-suggestions');
        const detailsSection = document.querySelector('.details-section');
        const calendarSection = document.querySelector('.calendar-section');

        if (!healthStatus || !aiSuggestions || !detailsSection || !calendarSection) {
          throw new Error('必要なセクションが見つかりません');
        }

        const aiRect = aiSuggestions.getBoundingClientRect();
        const detailsRect = detailsSection.getBoundingClientRect();
        const bodyRect = document.body.getBoundingClientRect();

        const dividerOffset = 50;

        const w = Math.round(bodyRect.width);
        const aiTop = Math.round(aiRect.top - dividerOffset);
        const detailsTop = Math.round(detailsRect.top - dividerOffset);
        const bodyHeight = Math.round(bodyRect.height);

        const h1 = aiTop;
        const h2 = detailsTop - aiTop;
        const h3 = bodyHeight - detailsTop;
        const maxH = Math.max(h1, h2, h3);

        return {
          maxHeight: maxH,
          screenshot1: { x: 0, y: 0, width: w, height: h1 },
          screenshot2: { x: 0, y: aiTop, width: w, height: h2 },
          screenshot3: { x: 0, y: detailsTop, width: w, height: h3 }
        };
      });
    } catch (error) {
      console.warn(`⚠️ セクション要素の取得に失敗しました: ${error.message}`);
      console.log('🔄 ローカルHTMLにフォールバック中...');
      const htmlPath = path.join(__dirname, '..', 'output', 'dashboard.html');
      try {
        url = await loadLocalHtml(page, htmlPath);
        console.log('✅ ローカルHTMLの読み込み成功');

        await page.waitForTimeout(2000);

        const newContentHeight = await page.evaluate(() => document.body.scrollHeight);
        await page.setViewportSize({ width: 1100, height: newContentHeight });

        sections = await page.evaluate(() => {
          const healthStatus = document.querySelector('.health-status');
          const aiSuggestions = document.querySelector('.ai-suggestions');
          const detailsSection = document.querySelector('.details-section');
          const calendarSection = document.querySelector('.calendar-section');

          if (!healthStatus || !aiSuggestions || !detailsSection || !calendarSection) {
            throw new Error('必要なセクションが見つかりません');
          }

          const aiRect = aiSuggestions.getBoundingClientRect();
          const detailsRect = detailsSection.getBoundingClientRect();
          const bodyRect = document.body.getBoundingClientRect();

          const dividerOffset = 50;

          const w = Math.round(bodyRect.width);
          const aiTop = Math.round(aiRect.top - dividerOffset);
          const detailsTop = Math.round(detailsRect.top - dividerOffset);
          const bodyHeight = Math.round(bodyRect.height);

          const h1 = aiTop;
          const h2 = detailsTop - aiTop;
          const h3 = bodyHeight - detailsTop;
          const maxH = Math.max(h1, h2, h3);

          return {
            maxHeight: maxH,
            screenshot1: { x: 0, y: 0, width: w, height: h1 },
            screenshot2: { x: 0, y: aiTop, width: w, height: h2 },
            screenshot3: { x: 0, y: detailsTop, width: w, height: h3 }
          };
        });
        console.log('✅ ローカルHTMLでセクション取得成功');
      } catch (localError) {
        console.error('❌ ローカルHTMLでのセクション取得にも失敗しました');
        throw localError;
      }
    }

    console.log('📐 セクション位置情報:', sections);

    const maxH = sections.maxHeight;
    const requiredHeight = sections.screenshot3.y + maxH;
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (requiredHeight > currentHeight) {
      await page.setViewportSize({ width: 1100, height: requiredHeight });
      await page.waitForTimeout(500);
    }

    const clips = [
      { ...sections.screenshot1, height: maxH },
      { ...sections.screenshot2, height: maxH },
      { ...sections.screenshot3, height: maxH }
    ];
    console.log(`📏 画像サイズ統一: 全て ${clips[0].width} x ${maxH} (元の高さ: ${sections.screenshot1.height}, ${sections.screenshot2.height}, ${sections.screenshot3.height})`);

    const screenshot1Path = path.join(screenshotDir, 'screenshot-1.png');
    await page.screenshot({ path: screenshot1Path, clip: clips[0], type: 'png' });
    console.log('✅ スクリーンショット1保存完了:', screenshot1Path);

    const screenshot2Path = path.join(screenshotDir, 'screenshot-2.png');
    await page.screenshot({ path: screenshot2Path, clip: clips[1], type: 'png' });
    console.log('✅ スクリーンショット2保存完了:', screenshot2Path);

    const screenshot3Path = path.join(screenshotDir, 'screenshot-3.png');
    await page.screenshot({ path: screenshot3Path, clip: clips[2], type: 'png' });
    console.log('✅ スクリーンショット3保存完了:', screenshot3Path);

    return { screenshot1Path, screenshot2Path, screenshot3Path };
  } catch (error) {
    console.error('❌ スクリーンショットエラー:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  takeScreenshot();
}

export default takeScreenshot;

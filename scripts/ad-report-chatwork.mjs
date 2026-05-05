#!/usr/bin/env node
/**
 * dashboard.html をスクリーンショット撮影して Chatwork に投稿する
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DASHBOARD_URL   = 'https://ad-report-design.surge.sh/dashboard.html';
const SCREENSHOT_PATH = path.join(__dirname, '..', 'output', 'ad-report.png');
const CHATWORK_TOKEN  = process.env.CHATWORK_TOKEN;
const CHATWORK_ROOM   = process.env.CHATWORK_ROOM_ID;

if (!CHATWORK_TOKEN || !CHATWORK_ROOM) {
  console.error('❌ 環境変数 CHATWORK_TOKEN と CHATWORK_ROOM_ID を設定してください');
  process.exit(1);
}

async function takeScreenshot() {
  console.log('🌐 ブラウザ起動中...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=ja-JP']
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1100, height: 900 });

  console.log(`📄 ページ読み込み中: ${DASHBOARD_URL}`);
  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // GASからデータ取得完了を待つ（dashboard.htmlがdata-loaded="true"を設定する）
  console.log('⏳ データ読み込み完了を待機中...');
  await page.waitForFunction(
    () => document.documentElement.dataset.loaded === 'true',
    { timeout: 30000 }
  );

  // レンダリング安定待ち
  await page.waitForTimeout(1000);

  // ページ全体の高さに合わせてビューポートを調整
  const contentHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewportSize({ width: 1100, height: contentHeight });
  await page.waitForTimeout(500);

  await fs.mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true, type: 'png' });
  console.log(`✅ スクリーンショット保存: ${SCREENSHOT_PATH}`);

  await browser.close();
}

async function postToChatwork() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  const fileData = await fs.readFile(SCREENSHOT_PATH);
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

  // multipart/form-data を手動構築
  const messagePart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="message"\r\n\r\n` +
    `[info][title]📊 ${dateStr} Web広告レポート[/title]スマートニュース 前日データ（料率確定後）[/info]\r\n`;

  const filePart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="ad-report.png"\r\n` +
    `Content-Type: image/png\r\n\r\n`;

  const ending = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(messagePart, 'utf8'),
    Buffer.from(filePart, 'utf8'),
    fileData,
    Buffer.from(ending, 'utf8')
  ]);

  console.log(`📤 Chatwork に投稿中 (room: ${CHATWORK_ROOM})...`);
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${CHATWORK_ROOM}/files`, {
    method: 'POST',
    headers: {
      'X-ChatWorkToken': CHATWORK_TOKEN,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  const json = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log('✅ Chatwork 投稿成功:', json);
  } else {
    console.error('❌ Chatwork 投稿失敗:', res.status, json);
    process.exit(1);
  }
}

(async () => {
  try {
    await takeScreenshot();
    await postToChatwork();
    console.log('🎉 完了');
  } catch (err) {
    console.error('❌ エラー:', err);
    process.exit(1);
  }
})();

#!/usr/bin/env node
/**
 * dashboard.html をスクリーンショット撮影して Chatwork/Slack に投稿する
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { notify, notifyWithFile } from './notifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DASHBOARD_URL   = 'https://ad-report-design.surge.sh/dashboard.html';
const SCREENSHOT_PATH = path.join(__dirname, '..', 'output', 'ad-report.png');

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

// JST で「前日」の日付文字列を返す
function getYesterdayJST() {
  const now  = new Date(Date.now() + 9 * 3600 * 1000);
  const yest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return `${yest.getUTCFullYear()}年${yest.getUTCMonth() + 1}月${yest.getUTCDate()}日`;
}

async function postToAll() {
  const dateStr = getYesterdayJST();
  const fileData = await fs.readFile(SCREENSHOT_PATH);

  // Chatwork: ④ 完了メッセージ → ⑤ ファイル付きレポート（2通）
  await notify(`✅ ${dateStr}迄の集計が完了しました。`);
  console.log('✅ 完了メッセージ送信');

  const reportMessage = `[info][title]📊 ${dateStr}迄の広告レポート[/title]スマートニュース 前日データ（料率確定後）[/info]`;

  // Slack: 完了 + レポート + 画像を1通にまとめる
  const slackCombined = `✅ ${dateStr}迄の集計が完了しました。\n*📊 ${dateStr}迄の広告レポート*\nスマートニュース 前日データ（料率確定後）`;

  console.log('📤 レポートを送信中...');
  await notifyWithFile(reportMessage, fileData, 'ad-report.png', { slackText: slackCombined });
  console.log('✅ レポート送信完了');
}

(async () => {
  try {
  await takeScreenshot();
  await postToAll();
    console.log('🎉 完了');
  } catch (err) {
    console.error('❌ エラー:', err);
    process.exit(1);
  }
})();

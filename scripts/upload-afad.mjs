#!/usr/bin/env node
/**
 * AFAD から期間レポートCSVをダウンロードして CV_raw シートに書き込む
 */
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AFAD_ID       = process.env.AFAD_ID;
const AFAD_PASSWORD = process.env.AFAD_PASSWORD;
const GAS_URL       = process.env.GAS_URL;
const CHATWORK_TOKEN = process.env.CHATWORK_TOKEN;
const CHATWORK_ROOM  = process.env.CHATWORK_ROOM_ID;

if (!AFAD_ID || !AFAD_PASSWORD || !GAS_URL) {
  console.error('❌ 環境変数 AFAD_ID / AFAD_PASSWORD / GAS_URL を設定してください');
  process.exit(1);
}

// JST で「今月1日」と「昨日」を取得
function getDateRange() {
  const now   = new Date(Date.now() + 9 * 3600 * 1000); // UTC→JST
  const y     = now.getUTCFullYear();
  const m     = now.getUTCMonth(); // 0-indexed
  const d     = now.getUTCDate();
  const start = `${y}/${String(m + 1).padStart(2, '0')}/01`;
  const yest  = new Date(Date.UTC(y, m, d - 1));
  const end   = `${yest.getUTCFullYear()}/${String(yest.getUTCMonth() + 1).padStart(2, '0')}/${String(yest.getUTCDate()).padStart(2, '0')}`;
  return { start, end };
}

async function notifyChatwork(msg) {
  if (!CHATWORK_TOKEN || !CHATWORK_ROOM) return;
  await fetch(`https://api.chatwork.com/v2/rooms/${CHATWORK_ROOM}/messages`, {
    method: 'POST',
    headers: { 'X-ChatWorkToken': CHATWORK_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `body=${encodeURIComponent(msg)}`
  }).catch(() => {});
}

async function main() {
  const { start, end } = getDateRange();
  console.log(`📅 期間: ${start} 〜 ${end}`);

  const downloadDir = path.join(__dirname, '..', 'output', 'downloads');
  await fs.mkdir(downloadDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // HTTP Basic 認証を Playwright のコンテキストに設定
    const context = await browser.newContext({
      httpCredentials: { username: AFAD_ID, password: AFAD_PASSWORD },
      acceptDownloads: true
    });
    const page = await context.newPage();

    console.log('🌐 AFAD にアクセス中...');
    await page.goto('https://afad.birdmotion.net/admin', { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`✅ ログイン完了: ${page.url()}`);

    // ── レポート集計 → 期間別 ──
    console.log('📊 期間別レポートに移動...');
    // サイドメニューの「レポート集計」をクリック
    await page.getByText('レポート集計').first().click().catch(async () => {
      await page.locator('a, li, span').filter({ hasText: 'レポート集計' }).first().click();
    });
    await page.waitForTimeout(500);

    // 「期間別」をクリック
    await page.getByText('期間別').first().click().catch(async () => {
      await page.locator('a, li, span').filter({ hasText: '期間別' }).first().click();
    });
    await page.waitForLoadState('networkidle');
    console.log(`✅ 期間別ページ: ${page.url()}`);

    // ── 絞り込み検索 ──
    console.log('🔍 絞り込み検索を開く...');
    await page.getByText('絞り込み検索').first().click();
    await page.waitForTimeout(500);

    // ── 日別 を選択 ──
    console.log('📆 「日別」を選択...');
    // ラジオボタンまたはセレクトボックスで「日別」を選択
    const dailyRadio = page.locator('input[type="radio"]').filter({ hasText: '日別' });
    if (await dailyRadio.count() > 0) {
      await dailyRadio.click();
    } else {
      await page.getByRole('radio', { name: '日別' }).click().catch(async () => {
        await page.getByLabel('日別').click().catch(async () => {
          await page.getByText('日別').first().click();
        });
      });
    }

    // ── 日付を設定 ──
    console.log(`📅 日付設定: ${start} 〜 ${end}`);
    // 開始日
    const startInputs = page.locator('input[type="text"], input[type="date"]');
    const startCount = await startInputs.count();
    if (startCount >= 2) {
      await startInputs.nth(0).fill(start);
      await startInputs.nth(1).fill(end);
    } else {
      // name/placeholder ベースで探す
      await page.locator('input[name*="start"], input[id*="start"], input[placeholder*="開始"]').first().fill(start).catch(() => {});
      await page.locator('input[name*="end"], input[id*="end"], input[placeholder*="終了"]').first().fill(end).catch(() => {});
    }

    // ── 広告主 = ミルクG ──
    console.log('🏢 広告主を「ミルクG」に設定...');
    // セレクトボックスの場合
    const advertiserSelect = page.locator('select').filter({ has: page.locator('option').filter({ hasText: 'ミルクG' }) });
    if (await advertiserSelect.count() > 0) {
      await advertiserSelect.selectOption({ label: 'ミルクG' });
    } else {
      // テキストフィールドの場合
      await page.locator('input[name*="advertiser"], input[id*="advertiser"], input[placeholder*="広告主"]').first().fill('ミルクG').catch(() => {});
    }

    // ── 検索 ──
    console.log('🔎 検索実行...');
    await page.getByRole('button', { name: '検索' }).click().catch(async () => {
      await page.getByText('検索').first().click();
    });
    await page.waitForLoadState('networkidle');
    console.log('✅ 検索完了');

    // ── CSV生成・ダウンロード ──
    console.log('⬇️ CSV生成...');
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.getByText('CSV生成').click().catch(async () => {
      await page.getByRole('button', { name: /CSV/ }).click().catch(async () => {
        await page.getByText('CSVダウンロード').click();
      });
    });
    const download = await downloadPromise;
    const csvPath  = path.join(downloadDir, 'afad.csv');
    await download.saveAs(csvPath);
    console.log(`✅ CSV保存: ${csvPath}`);

    // ── GAS 経由でスプレッドシートに書き込み ──
    const csv = await fs.readFile(csvPath, 'utf-8');
    console.log(`📤 GAS に送信中... (${csv.length} bytes)`);

    const res  = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: 'CV_raw', csv, startCell: 'B1' }),
      redirect: 'follow'
    });
    const json = await res.json().catch(() => ({}));

    if (json.ok) {
      console.log(`✅ CV_raw 更新完了: ${json.rows}行 × ${json.cols}列`);
      await notifyChatwork(`✅ AFAD CV_rawデータ更新完了（${json.rows - 1}日分）`);
    } else {
      throw new Error('GAS書き込みエラー: ' + (json.error || JSON.stringify(json)));
    }

  } finally {
    await browser.close();
  }
}

main().catch(async err => {
  console.error('❌ エラー:', err.message);
  await notifyChatwork(`⚠️ AFAD自動化エラー: ${err.message}`);
  process.exit(1);
});

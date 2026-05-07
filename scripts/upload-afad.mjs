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
    await page.waitForTimeout(800);

    // ── 日別 を選択 ──
    console.log('📆 「日別」を選択...');
    const dailyLabel = page.locator('label').filter({ hasText: /^日別$/ });
    if (await dailyLabel.count() > 0) {
      await dailyLabel.first().click();
      console.log('✅ 日別: ラベルクリック');
    } else {
      await page.getByText('日別').first().click();
      console.log('✅ 日別: テキストクリック');
    }
    await page.waitForTimeout(500);

    // ── 日付をカレンダーUIで設定 ──
    console.log(`📅 日付設定: ${start} 〜 ${end}`);

    // 日付をパース
    const [sy, sm, sd] = start.split('/').map(Number); // start: 2026/05/01
    const [ey, em, ed] = end.split('/').map(Number);   // end:   2026/05/06

    // 日付入力欄（範囲ピッカー）をクリックしてカレンダーを開く
    const dateRangeInput = page.locator('#searchReportStartDate, input[name="searchReportStartDate"]').first();
    await dateRangeInput.click({ force: true });
    await page.waitForTimeout(800);

    // カレンダーが開いた後のスクリーンショット
    await page.screenshot({ path: path.join(downloadDir, 'afad-01-calendar-open.png') });

    // カレンダー内で開始日（月1日）をクリック
    // .day セルで「1」というテキストを持つものを探す（"prev" や "next" クラスを避ける）
    const startDayCell = page.locator('td.day:not(.old):not(.new)').filter({ hasText: new RegExp(`^${sd}$`) }).first();
    if (await startDayCell.count() > 0) {
      await startDayCell.click();
      console.log(`✅ 開始日 ${sd}日 クリック`);
    } else {
      // 月ナビゲーション後に再試行
      console.log('⚠ 開始日セルが見つからない、月移動を試みる');
      await page.locator('.datepicker-days th.prev').first().click().catch(() => {});
      await page.waitForTimeout(300);
      await page.locator('td.day:not(.old):not(.new)').filter({ hasText: new RegExp(`^${sd}$`) }).first().click().catch(() => {});
    }
    await page.waitForTimeout(300);

    // 終了日をクリック
    const endDayCell = page.locator('td.day:not(.old):not(.new)').filter({ hasText: new RegExp(`^${ed}$`) }).first();
    if (await endDayCell.count() > 0) {
      await endDayCell.click();
      console.log(`✅ 終了日 ${ed}日 クリック`);
    } else {
      console.log('⚠ 終了日セルが見つからない');
    }
    await page.waitForTimeout(300);

    // Escape でカレンダーを閉じる
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // 日付セット後のスクリーンショット（入力欄に正しい日付が入ったか）
    await page.screenshot({ path: path.join(downloadDir, 'afad-02-after-date.png') });

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

    // ── 検索（フォームの検索ボタンを確実にクリック） ──
    console.log('🔎 検索実行...');
    // カレンダーが閉じていることを確認してからクリック
    await page.locator('.datepicker').first().evaluate(el => el.style.display = 'none').catch(() => {});
    const searchBtn = page.locator('button[type="submit"]').filter({ hasText: '検索' })
      .or(page.locator('input[type="submit"][value="検索"]'))
      .or(page.locator('button').filter({ hasText: /^検索$/ }))
      .last(); // カレンダー内のボタンではなくフォームのボタン（最後）
    await searchBtn.click({ force: true });
    await page.waitForLoadState('networkidle');
    console.log('✅ 検索完了');

    // 検索後スクリーンショット（結果行数を確認）
    await page.screenshot({ path: path.join(downloadDir, 'afad-03-after-search.png'), fullPage: true });

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
    const csvLines = csv.split('\n').filter(l => l.trim());
    console.log(`📋 CSVプレビュー（先頭5行）:`);
    csvLines.slice(0, 5).forEach((l, i) => console.log(`  [${i}] ${l.substring(0, 120)}`));
    console.log(`📤 GAS に送信中... (${csv.length} bytes, ${csvLines.length}行)`);

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

#!/usr/bin/env node
/**
 * スマートニュース管理画面から日別CSVをダウンロードして SN_raw シートに書き込む
 * 事前に save-sn-auth.mjs を実行してSN_AUTH_STATEをGitHub Secretsに保存しておくこと
 */
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SN_AUTH_STATE  = process.env.SN_AUTH_STATE;
const GAS_URL        = process.env.GAS_URL;
const CHATWORK_TOKEN = process.env.CHATWORK_TOKEN;
const CHATWORK_ROOM  = process.env.CHATWORK_ROOM_ID;

if (!SN_AUTH_STATE || !GAS_URL) {
  console.error('❌ 環境変数 SN_AUTH_STATE / GAS_URL を設定してください');
  console.error('💡 SN_AUTH_STATE は save-sn-auth.mjs を実行して取得してください');
  process.exit(1);
}

// JST で「今月1日」と「昨日」を取得（YYYY-MM-DD 形式）
function getDateRange() {
  const now  = new Date(Date.now() + 9 * 3600 * 1000);
  const y    = now.getUTCFullYear();
  const m    = now.getUTCMonth();
  const d    = now.getUTCDate();
  const yest = new Date(Date.UTC(y, m, d - 1));
  const fmt  = dt => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  return { start: fmt(new Date(Date.UTC(y, m, 1))), end: fmt(yest) };
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

  // 認証状態をファイルに一時保存
  const authPath = path.join(downloadDir, 'sn-auth-tmp.json');
  await fs.writeFile(authPath, SN_AUTH_STATE);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      storageState: authPath,
      acceptDownloads: true
    });
    const page = await context.newPage();

    console.log('🌐 スマートニュース管理画面にアクセス...');
    await page.goto('https://ads.smartnews.com/bm/businesses', { waitUntil: 'networkidle', timeout: 30000 });

    // ログイン状態を確認
    if (page.url().includes('accounts.smartnews.com') || page.url().includes('signIn')) {
      throw new Error('SESSION_EXPIRED');
    }
    console.log(`✅ ログイン済み: ${page.url()}`);

    // URLからビジネスIDを抽出（例: /bm/businesses/102459874/...）
    const bizIdMatch = page.url().match(/businesses\/(\d+)/);
    const bizId = bizIdMatch ? bizIdMatch[1] : null;
    console.log(`🏢 ビジネスID: ${bizId}`);

    // スクリーンショット（ログイン後の画面）
    await page.screenshot({ path: path.join(downloadDir, 'sn-01-after-login.png') });

    // ── レポートページに直接移動 ──
    console.log('📊 レポートページに移動...');
    // ビジネスIDが取れた場合は直接URLで移動、取れない場合はナビゲーションから
    if (bizId) {
      // キャンペーンレポートURLを直接開く
      const reportUrl = `https://ads.smartnews.com/bm/businesses/${bizId}/campaigns`;
      await page.goto(reportUrl, { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`✅ キャンペーンページ: ${page.url()}`);
    }

    await page.screenshot({ path: path.join(downloadDir, 'sn-02-report-page.png') });

    // ── 日別表示に切り替え ──
    console.log('📆 日別を選択...');
    // ディメンション選択（Daily/日別）
    await page.getByText('日別').first().click().catch(async () => {
      await page.getByText('Daily').first().click().catch(() => {});
    });
    await page.waitForTimeout(1000);

    // ── 日付範囲を設定（今月） ──
    console.log(`📅 日付設定: ${start} 〜 ${end}`);
    // 期間選択ドロップダウンを開く
    const datePickerTriggers = [
      () => page.getByText('今月').click(),
      () => page.getByText('This Month').click(),
      () => page.locator('[data-testid*="date"], [class*="date-picker"], [class*="DatePicker"]').first().click(),
      () => page.getByText('カスタム').click(),
    ];
    for (const trigger of datePickerTriggers) {
      const ok = await trigger().then(() => true).catch(() => false);
      if (ok) { console.log('✅ 期間選択クリック成功'); break; }
    }
    await page.waitForTimeout(1000);

    await page.screenshot({ path: path.join(downloadDir, 'sn-03-date-set.png') });

    // ── CSVダウンロード ──
    console.log('⬇️ CSVをダウンロード...');
    await page.screenshot({ path: path.join(downloadDir, 'sn-04-before-download.png') });
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

    await page.getByRole('button', { name: /ダウンロード|download|CSV/i }).first().click().catch(async () => {
      await page.getByText('レポートをダウンロード').click().catch(async () => {
        await page.locator('[aria-label*="ダウンロード"], [title*="ダウンロード"], [aria-label*="download"], [aria-label*="export"]').first().click().catch(async () => {
          // アイコンボタンを探す
          await page.locator('button').filter({ has: page.locator('svg, i[class*="download"], i[class*="export"]') }).first().click();
        });
      });
    });

    const download = await downloadPromise;
    const csvPath  = path.join(downloadDir, 'smartnews.csv');
    await download.saveAs(csvPath);
    console.log(`✅ CSV保存: ${csvPath}`);

    // ── GAS 経由でスプレッドシートに書き込み ──
    const csv  = await fs.readFile(csvPath, 'utf-8');
    console.log(`📤 GAS に送信中... (${csv.length} bytes)`);

    const res  = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet: 'SN_raw', csv, startCell: 'A1' }),
      redirect: 'follow'
    });
    const json = await res.json().catch(() => ({}));

    if (json.ok) {
      console.log(`✅ SN_raw 更新完了: ${json.rows}行 × ${json.cols}列`);
      await notifyChatwork(`✅ スマートニュース SN_rawデータ更新完了（${start}〜${end}）`);
    } else {
      throw new Error('GAS書き込みエラー: ' + (json.error || JSON.stringify(json)));
    }

  } finally {
    await fs.unlink(authPath).catch(() => {});
    await browser.close();
  }
}

main().catch(async err => {
  if (err.message === 'SESSION_EXPIRED') {
    console.error('⚠️ スマートニュースのセッションが切れています');
    await notifyChatwork(
      '[info][title]⚠️ スマートニュース 再ログインが必要です[/title]' +
      'セッションが切れました。Macで以下のコマンドを実行して再ログインしてください：\n\n' +
      '`GITHUB_PAT=<トークン> node scripts/save-sn-auth.mjs`[/info]'
    );
  } else {
    console.error('❌ エラー:', err.message);
    await notifyChatwork(`⚠️ スマートニュース自動化エラー: ${err.message}`);
  }
  process.exit(1);
});

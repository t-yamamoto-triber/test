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

    // URLからビジネスIDを抽出
    const bizIdMatch = page.url().match(/businesses\/(\d+)/);
    const bizId = bizIdMatch ? bizIdMatch[1] : null;
    console.log(`🏢 ビジネスID: ${bizId}`);

    // スクリーンショット（ログイン後）
    await page.screenshot({ path: path.join(downloadDir, 'sn-01-after-login.png') });

    // ── レポートページへ移動（ビジネストップから探す） ──
    console.log('📊 レポートページに移動...');
    // ビジネストップページに移動してナビゲーションを確認
    if (bizId) {
      await page.goto(`https://ads.smartnews.com/bm/businesses/${bizId}`, {
        waitUntil: 'networkidle', timeout: 30000
      }).catch(() => {});
    }
    console.log(`📍 現在のURL: ${page.url()}`);
    await page.screenshot({ path: path.join(downloadDir, 'sn-02-biz-top.png') });

    // ページ内のリンク一覧をログ出力（レポートURLを特定するため）
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ text: a.textContent.trim().slice(0, 30), href: a.href }))
        .filter(l => l.href.includes('smartnews'))
        .slice(0, 20)
    );
    console.log('🔗 ページ内リンク:', JSON.stringify(links));

    // 「レポート」リンクをクリック（ナビゲーションから）
    const reportLink = page.locator('a, button, [role="tab"]').filter({ hasText: /^レポート$|^Report$/ });
    if (await reportLink.count() > 0) {
      await reportLink.first().click();
      await page.waitForLoadState('networkidle');
      console.log(`✅ レポートページ: ${page.url()}`);
    } else {
      // ナビゲーションで見つからない場合、広告アカウントへ直接移動を試みる
      console.log('⚠ レポートリンクが見つからない。広告アカウントページを試みる...');
      await page.goto('https://ads.smartnews.com/bm/ad_accounts', {
        waitUntil: 'networkidle', timeout: 30000
      }).catch(() => {});
      console.log(`📍 広告アカウントURL: ${page.url()}`);
    }
    await page.screenshot({ path: path.join(downloadDir, 'sn-03-report-page.png') });

    // ── 今月ボタンで日付設定 ──
    console.log('📅 「今月」で期間設定...');
    await page.waitForTimeout(1000);

    // 「今月」ボタンをJS経由でクリック（オーバーレイ対応）
    const monthResult = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, li, a, [role="option"]'));
      const btn = candidates.find(el => /^今月$|^Today$|^This Month$/i.test(el.textContent.trim()));
      if (btn) { btn.click(); return { clicked: true, text: btn.textContent.trim() }; }
      return { clicked: false };
    });
    console.log('📅 今月ボタン:', JSON.stringify(monthResult));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(downloadDir, 'sn-04-date-set.png') });

    // ── 日別にチェック ──
    console.log('📆 日別を選択...');
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"], button, li, [role="option"]'));
      const btn = candidates.find(el => /^日別$|^Daily$/i.test(el.textContent.trim() || el.value || el.labels?.[0]?.textContent.trim()));
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForTimeout(500);

    // ── CSVダウンロード ──
    console.log('⬇️ CSVをダウンロード...');
    await page.screenshot({ path: path.join(downloadDir, 'sn-05-before-download.png') });
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });

    // ダウンロードボタンをJS経由でクリック
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const btn = candidates.find(el => /ダウンロード|download|CSV|エクスポート|export/i.test(el.textContent.trim() + el.getAttribute('aria-label')));
      if (btn) btn.click();
    }).catch(() => {
      page.locator('button').filter({ hasText: /ダウンロード|CSV|export/i }).first().click().catch(() => {});
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

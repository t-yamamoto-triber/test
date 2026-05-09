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

    // スクリーンショット（ログイン後）
    await page.screenshot({ path: path.join(downloadDir, 'sn-01-after-login.png') });

    // ── レポートページへ直接移動 ──
    const REPORT_URL = 'https://ads.smartnews.com/am/ad_accounts/102459875/campaigns?report=standard';
    console.log(`📊 レポートページに移動: ${REPORT_URL}`);
    await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log(`✅ レポートページ: ${page.url()}`);
    await page.screenshot({ path: path.join(downloadDir, 'sn-02-report-page.png') });

    // ページ読み込み完了を待つ
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(downloadDir, 'sn-03-loaded.png') });

    // ── 日付ピッカーで「今月1日〜昨日」を設定 ──
    console.log(`📅 日付を設定: ${start} 〜 ${end}`);
    const dateSetResult = await page.evaluate(({ start, end }) => {
      // 日付入力欄を探す（テキスト入力 or date型）
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="date"], input[placeholder*="date"], input[placeholder*="Date"]'));
      // 開始・終了日入力欄を特定（2つ並んでいることが多い）
      if (inputs.length >= 2) {
        const startInput = inputs[0];
        const endInput   = inputs[1];
        // React管理フィールドへの値セット
        const setVal = (el, val) => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(el, val);
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(startInput, start);
        setVal(endInput,   end);
        return { ok: true, method: 'input', count: inputs.length };
      }
      return { ok: false, inputCount: inputs.length };
    }, { start, end });
    console.log('📅 日付入力結果:', JSON.stringify(dateSetResult));

    // 日付確定ボタン（適用 / Apply / 検索 等）をクリック
    const applyResult = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(el =>
        /適用|apply|確定|search|検索/i.test(el.textContent.trim())
      );
      if (btn) { btn.click(); return { clicked: true, text: btn.textContent.trim() }; }
      return { clicked: false };
    });
    console.log('✅ 日付確定ボタン:', JSON.stringify(applyResult));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(downloadDir, 'sn-03b-after-date-set.png') });

    // ── ダウンロードイベントを先に登録（クリックより前に設定が必須） ──
    const downloadPromise = page.waitForEvent('download', { timeout: 90000 });

    // ── 「レポート」ボタンをクリック ──
    console.log('⬇️ レポートボタンをクリック...');
    const reportBtnResult = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const btn = candidates.find(el => {
        const text = el.textContent.trim();
        return text === 'レポート' || text === '↓ レポート' || text.endsWith('レポート');
      });
      if (btn) { btn.click(); return { clicked: true, text: btn.textContent.trim() }; }
      return { clicked: false };
    });
    console.log('📥 レポートボタン:', JSON.stringify(reportBtnResult));

    // モーダルが開くのを待つ
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(downloadDir, 'sn-04-after-report-click.png'), fullPage: true });

    // モーダル内で「日別」を選択（集計の粒度）
    const dailyResult = await page.evaluate(() => {
      // label または radio ボタンで「日別」を探す
      const labels = Array.from(document.querySelectorAll('label, span, div'));
      const dailyLabel = labels.find(el => el.textContent.trim() === '日別');
      if (dailyLabel) {
        dailyLabel.click();
        // 関連するinputも探してクリック
        const input = dailyLabel.querySelector('input') || dailyLabel.previousElementSibling;
        if (input?.tagName === 'INPUT') input.click();
        return { clicked: true, method: 'label', text: dailyLabel.textContent.trim() };
      }
      // radio input で value が "daily" 等を探す
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
      const daily = radios.find(r => /daily|日別/i.test(r.value + r.id + r.name + (r.labels?.[0]?.textContent || '')));
      if (daily) { daily.click(); return { clicked: true, method: 'radio', value: daily.value }; }
      return { clicked: false };
    });
    console.log('📆 日別選択:', JSON.stringify(dailyResult));
    await page.waitForTimeout(500);

    // モーダル内の「ダウンロード」ボタンをクリック
    const modalBtnResult = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const btn = candidates.find(el => /ダウンロード|download/i.test(el.textContent.trim()));
      if (btn) { btn.click(); return { clicked: true, text: btn.textContent.trim() }; }
      return { clicked: false };
    });
    console.log('📥 モーダルボタン:', JSON.stringify(modalBtnResult));
    console.log('⏳ ダウンロード待機中...');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(downloadDir, 'sn-05-after-modal-click.png'), fullPage: true });

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

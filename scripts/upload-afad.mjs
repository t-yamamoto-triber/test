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
    await page.waitForTimeout(500);

    // ── 日付を設定（Bootstrap datepicker対応） ──
    console.log(`📅 日付設定: ${start} 〜 ${end}`);

    // セット前スクリーンショット
    await page.screenshot({ path: path.join(downloadDir, 'afad-01-before-date.png') });

    // datepicker の設定情報を取得
    const dpConfig = await page.evaluate(() => {
      const el = document.getElementById('searchReportStartDate');
      if (!el) return { error: 'element not found' };
      const info = { value: el.value, readOnly: el.readOnly, type: el.type };
      if (typeof $ !== 'undefined') {
        const dp = $(el).data('datepicker');
        if (dp) {
          info.dpFormat = dp.o?.format;
          info.dpMinViewMode = dp.o?.minViewMode;
          info.dpDate = dp.date?.toString?.();
        } else {
          info.dpError = 'no datepicker instance';
        }
      } else {
        info.dpError = 'no jQuery';
      }
      return info;
    });
    console.log('📋 datepicker設定:', JSON.stringify(dpConfig));

    // Bootstrap datepicker API でセット（Date オブジェクト）
    const dateResult = await page.evaluate(({ s, e }) => {
      function setBootstrapDate(id, dateStr) {
        const el = document.getElementById(id);
        if (!el) return { ok: false, reason: 'not found' };

        const [y, m, d] = dateStr.split('/').map(Number);
        const dateObj = new Date(y, m - 1, d);

        if (typeof $ !== 'undefined') {
          const $el = $(el);
          const dp = $el.data('datepicker');
          if (dp) {
            $el.datepicker('setDate', dateObj);
            $el.datepicker('update');
            return { ok: true, method: 'bootstrap-setDate', value: el.value };
          }
          // datepicker がなければ直接 val() でセット
          const fmt = dp?.o?.format || '';
          const pad = n => String(n).padStart(2, '0');
          let formatted = dateStr;
          if (fmt.includes('年')) {
            formatted = `${y}年${pad(m)}月${pad(d)}日`;
          }
          $el.val(formatted).trigger('change');
          return { ok: true, method: 'jquery-val', value: el.value };
        }

        // jQuery がない場合はネイティブ
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, dateStr);
        ['change', 'input'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
        return { ok: true, method: 'native', value: el.value };
      }

      return {
        start: setBootstrapDate('searchReportStartDate', s),
        end:   setBootstrapDate('searchReportEndDate', e)
      };
    }, { s: start, e: end });

    console.log('📅 日付セット結果:', JSON.stringify(dateResult));

    // セット後スクリーンショット（日付が正しく入ったか確認）
    await page.screenshot({ path: path.join(downloadDir, 'afad-02-after-date.png') });
    await page.waitForTimeout(500);

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

    // 検索後スクリーンショット（結果の日付範囲を確認）
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

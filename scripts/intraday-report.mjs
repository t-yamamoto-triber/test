#!/usr/bin/env node
/**
 * 当日速報レポート
 * スマートニュース・AFAD の当日データを取得して Slack にテキスト送信
 * 実行タイミング: 9:00 / 12:00 / 15:00 / 18:00 / 21:00 / 23:59 JST
 */
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AFAD_ID        = process.env.AFAD_ID;
const AFAD_PASSWORD  = process.env.AFAD_PASSWORD;
const SN_AUTH_STATE  = process.env.SN_AUTH_STATE;
const SLACK_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL  = process.env.SLACK_CHANNEL_ID;
const GITHUB_EVENT   = process.env.GITHUB_EVENT_NAME || '';

// JST 現在日時
function nowJST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return { date: `${y}-${m}-${d}`, label: `${Number(m)}月${Number(d)}日 ${hh}:${mm}` };
}

// 数値を ¥xxx,xxx 形式に
function yen(n) {
  if (n === null || isNaN(n)) return '－';
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

// Slack にテキスト送信
async function sendSlack(text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL.trim(), text })
  });
  const data = await res.json();
  if (!data.ok) console.error('Slack送信エラー:', data.error);
}

// ── スマートニュース: 当日サマリーを取得 ──
async function fetchSmartNews(downloadDir) {
  if (!SN_AUTH_STATE) return null;

  const authPath = path.join(__dirname, '..', 'output', 'sn-auth.json');
  await fs.writeFile(authPath, SN_AUTH_STATE);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext({ storageState: authPath, acceptDownloads: true });
    const page = await context.newPage();

    // セッション確認
    await page.goto('https://ads.smartnews.com/bm/businesses', { waitUntil: 'networkidle', timeout: 30000 });
    if (page.url().includes('signIn')) {
      console.log('⚠️ SN: セッション切れ');
      return null;
    }

    // レポートページへ（当日のデータが見える画面）
    const today = nowJST().date;
    const REPORT_URL = 'https://ads.smartnews.com/am/ad_accounts/102459875/campaigns?report=standard';
    await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 日付を「今日」に設定
    await page.evaluate((today) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="date"]'));
      if (inputs.length >= 2) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inputs[0], today);
        inputs[0].dispatchEvent(new Event('input',  { bubbles: true }));
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        setter.call(inputs[1], today);
        inputs[1].dispatchEvent(new Event('input',  { bubbles: true }));
        inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, today);

    // 適用ボタン
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(el =>
        /適用|apply|確定/i.test(el.textContent.trim())
      );
      if (btn) btn.click();
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(downloadDir, `intraday-sn-${today}.png`) });

    // 数値をページから抽出（金額・CV・CPA に相当する要素を探す）
    const data = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : null;
      };
      // ページ上の数値セルを幅広く取得してログに残す
      const cells = Array.from(document.querySelectorAll('td, [class*="cell"], [class*="value"], [class*="metric"]'))
        .map(el => el.textContent.trim())
        .filter(t => t && /[\d,¥$%]/.test(t))
        .slice(0, 30);
      return { cells };
    });
    console.log('SN cells:', JSON.stringify(data.cells));

    // 数値のパース（セル配列からそれらしい値を拾う）
    const nums = data.cells.map(c => {
      const n = parseFloat(c.replace(/[¥,$\s,]/g, '').replace(/,/g, ''));
      return isNaN(n) ? null : n;
    }).filter(n => n !== null);

    return { cells: data.cells, raw: nums };
  } catch (e) {
    console.error('SN取得エラー:', e.message);
    return null;
  } finally {
    await browser.close();
  }
}

// upload-afad.mjs と同じ導線で期間別・日別まで進み、「今月」集計結果のテーブルから当日行だけ拾う
async function fetchAFAD(downloadDir) {
  if (!AFAD_ID || !AFAD_PASSWORD) return null;

  const { date: todayIso } = nowJST();
  const [y, mo, da] = todayIso.split('-');
  const todayVariants = [
    todayIso,
    `${y}/${mo}/${da}`,
    `${y}/${Number(mo)}/${Number(da)}`,
    `${Number(mo)}/${Number(da)}`,
    `${mo}/${da}`
  ];

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext({
      httpCredentials: { username: AFAD_ID, password: AFAD_PASSWORD },
      acceptDownloads: true
    });
    const page = await context.newPage();

    console.log('🌐 AFAD にアクセス中...');
    await page.goto('https://afad.birdmotion.net/admin', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);

    await page.getByText('レポート集計').first().click().catch(async () => {
      await page.locator('a, li, span').filter({ hasText: 'レポート集計' }).first().click();
    });
    await page.waitForTimeout(500);

    await page.getByText('期間別').first().click().catch(async () => {
      await page.locator('a, li, span').filter({ hasText: '期間別' }).first().click();
    });
    await page.waitForLoadState('networkidle');

    console.log('🔍 絞り込み検索を開く...');
    await page.getByText('絞り込み検索').first().click();
    await page.waitForTimeout(800);

    const dailyLabel = page.locator('label').filter({ hasText: /^日別$/ });
    if (await dailyLabel.count() > 0) {
      await dailyLabel.first().click();
    } else {
      await page.getByText('日別').first().click();
    }
    await page.waitForTimeout(500);

    await page.locator('#searchReportAt').click();
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const btn = document.getElementById('current_month')
        || Array.from(document.querySelectorAll('button, li, a'))
          .find(el => el.textContent.trim() === '今月');
      if (btn) btn.click();
    });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const applyBtn = Array.from(document.querySelectorAll('button'))
        .find(el => /適用|Apply|確定/.test(el.textContent.trim()));
      if (applyBtn) applyBtn.click();
    }).catch(() => {});
    await page.waitForTimeout(500);

    const advertiserSelect = page.locator('select').filter({ has: page.locator('option').filter({ hasText: 'ミルクG' }) });
    if (await advertiserSelect.count() > 0) {
      await advertiserSelect.selectOption({ label: 'ミルクG' });
    } else {
      await page.locator('input[name*="advertiser"], input[id*="advertiser"], input[placeholder*="広告主"]').first().fill('ミルクG').catch(() => {});
    }

    await page.locator('.datepicker').first().evaluate(el => { el.style.display = 'none'; }).catch(() => {});
    const searchBtn = page.locator('button[type="submit"]').filter({ hasText: '検索' })
      .or(page.locator('input[type="submit"][value="検索"]'))
      .or(page.locator('button').filter({ hasText: /^検索$/ }))
      .last();
    await searchBtn.click({ force: true });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    await page.screenshot({ path: path.join(downloadDir, `intraday-afad-${todayIso}.png`), fullPage: true });

    const rowData = await page.evaluate((variants) => {
      const rows = Array.from(document.querySelectorAll('table tbody tr, tr'));
      for (const tr of rows) {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        if (tds.length === 0) continue;
        const first = tds[0];
        if (variants.some(v => first.includes(v) || first.startsWith(v))) {
          return { cells: tds, matched: first };
        }
      }
      return { cells: null, matched: null };
    }, todayVariants);

    console.log('AFAD 当日行:', JSON.stringify(rowData));
    if (!rowData.cells) return null;

    return { cells: rowData.cells, rowMatch: rowData.matched };
  } catch (e) {
    console.error('AFAD取得エラー:', e.message);
    return null;
  } finally {
    await browser.close();
  }
}

// ── メイン ──
async function main() {
  const { label } = nowJST();
  console.log(`⏰ 速報レポート開始: ${label}`);

  const downloadDir = path.join(__dirname, '..', 'output', 'downloads');
  await fs.mkdir(downloadDir, { recursive: true });

  // 並列取得
  const [snData, afadData] = await Promise.allSettled([
    fetchSmartNews(downloadDir),
    fetchAFAD(downloadDir)
  ]);

  const sn   = snData.status   === 'fulfilled' ? snData.value   : null;
  const afad = afadData.status === 'fulfilled' ? afadData.value : null;

  // ── メッセージ組み立て ──
  let msg = `📊 ${label} 時点の速報\n\n`;

  if (sn && sn.cells?.length > 0) {
    msg += `【スマートニュース】\n`;
    const spendCells = sn.cells.filter(c => /^[¥\d,]+$/.test(c.replace(/\s/g, '')) && parseInt(c.replace(/[¥,]/g, '')) > 10000);
    const cvCells    = sn.cells.filter(c => /^\d+$/.test(c) && parseInt(c) < 1000);
    msg += spendCells[0] ? `　広告費：${spendCells[0]}\n` : `　広告費：取得中\n`;
    msg += cvCells[0]    ? `　媒体CV：${cvCells[0]}件\n`  : `　媒体CV：取得中\n`;
    const spend = parseInt((spendCells[0] || '').replace(/[¥,]/g, ''));
    const cv    = parseInt(cvCells[0] || '0');
    if (spend > 0 && cv > 0) {
      msg += `　CPA：${yen(spend / cv)}\n`;
    }
  } else {
    msg += `【スマートニュース】\n　データ取得できませんでした\n`;
  }

  msg += `\n`;

  if (afad && afad.cells?.length > 1) {
    msg += `【AFAD（実計測CV）】\n`;
    const tail = afad.cells.slice(1).map(c => c.trim());
    const intVals = tail
      .map(t => {
        const m = String(t).replace(/,/g, '').match(/^(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(n => n != null && n > 0 && n < 1000000 && n !== 2024 && n !== 2025 && n !== 2026);
    const spendVals = tail
      .map(t => parseInt(String(t).replace(/[¥,\s]/g, ''), 10))
      .filter(n => !isNaN(n) && n >= 1000);
    const cvVal = intVals.filter(n => n < 50000).sort((a, b) => a - b)[0];
    const afadSpend = spendVals.sort((a, b) => b - a)[0];
    msg += cvVal ? `　計測CV：${cvVal}件\n` : `　計測CV：取得中\n`;
    if (afadSpend > 0 && cvVal > 0) {
      msg += `　CPA：${yen(afadSpend / cvVal)}\n`;
    } else if (cvVal > 0 && sn?.cells?.length > 0) {
      const snSpend = parseInt((sn.cells.find(c => parseInt(c.replace(/[¥,]/g, ''), 10) > 10000) || '').replace(/[¥,]/g, ''), 10);
      if (snSpend > 0) msg += `　CPA：${yen(snSpend / cvVal)}\n`;
    }
  } else {
    msg += `【AFAD（実計測CV）】\n　データ取得できませんでした\n`;
  }

  const triggerLabel =
    GITHUB_EVENT === 'schedule' ? '定時（GitHub の schedule）'
    : GITHUB_EVENT === 'workflow_dispatch' ? '手動（Actions の Run workflow）'
    : GITHUB_EVENT ? GITHUB_EVENT
    : 'ローカル等';
  msg += `\n_実行トリガー: ${triggerLabel}_`;

  console.log('📤 送信メッセージ:\n' + msg);
  await sendSlack(msg);
  console.log('✅ 速報レポート送信完了');
}

main().catch(e => {
  console.error('❌ エラー:', e);
  process.exit(1);
});

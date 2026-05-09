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

// ── AFAD: 当日サマリーを取得 ──
async function fetchAFAD(downloadDir) {
  if (!AFAD_ID || !AFAD_PASSWORD) return null;

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const context = await browser.newContext({
      httpCredentials: { username: AFAD_ID, password: AFAD_PASSWORD },
      acceptDownloads: true
    });
    const page = await context.newPage();

    await page.goto('https://afad.birdmotion.net/admin', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 期間レポートへ
    const periodLink = page.locator('a, button').filter({ hasText: /期間別|期間レポート/ }).first();
    if (await periodLink.count() > 0) {
      await periodLink.click();
      await page.waitForTimeout(2000);
    }

    // 「絞り込み検索」クリック
    const filterBtn = page.locator('button, a').filter({ hasText: /絞り込み/ }).first();
    if (await filterBtn.count() > 0) {
      await filterBtn.click();
      await page.waitForTimeout(1000);
    }

    const today = nowJST().date.replace(/-/g, '/');

    // 広告主: ミルクG
    const advSelect = page.locator('select').first();
    if (await advSelect.count() > 0) {
      await advSelect.selectOption({ label: /ミルクG/ }).catch(() => {});
    }

    // 日付: 今日だけ
    await page.evaluate((today) => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="date"]'));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      inputs.filter(i => i.placeholder?.includes('開始') || inputs.indexOf(i) === 0).forEach(i => {
        setter.call(i, today);
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      });
      inputs.filter(i => i.placeholder?.includes('終了') || inputs.indexOf(i) === 1).forEach(i => {
        setter.call(i, today);
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }, today);

    // 検索実行
    const searchBtn = page.locator('button').filter({ hasText: /^検索$/ }).first();
    if (await searchBtn.count() > 0) {
      await searchBtn.click();
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: path.join(downloadDir, `intraday-afad-${today}.png`) });

    // 数値を取得
    const data = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('td, [class*="cell"], [class*="value"]'))
        .map(el => el.textContent.trim())
        .filter(t => t && /[\d,]/.test(t))
        .slice(0, 30);
      return { cells };
    });
    console.log('AFAD cells:', JSON.stringify(data.cells));

    return { cells: data.cells };
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
    // cells の中から金額・件数・%を推測して表示
    const spendCells = sn.cells.filter(c => /^[¥\d,]+$/.test(c.replace(/\s/g, '')) && parseInt(c.replace(/[¥,]/g, '')) > 10000);
    const cvCells    = sn.cells.filter(c => /^\d+$/.test(c) && parseInt(c) < 1000);
    msg += spendCells[0] ? `　広告費：${spendCells[0]}\n` : `　広告費：取得中\n`;
    msg += cvCells[0]    ? `　計測CV：${cvCells[0]}件\n`  : `　計測CV：取得中\n`;
    // CPA = 広告費 / CV
    const spend = parseInt((spendCells[0] || '').replace(/[¥,]/g, ''));
    const cv    = parseInt(cvCells[0] || '0');
    if (spend > 0 && cv > 0) {
      msg += `　CPA：${yen(spend / cv)}\n`;
    }
  } else {
    msg += `【スマートニュース】\n　データ取得できませんでした\n`;
  }

  msg += `\n`;

  if (afad && afad.cells?.length > 0) {
    msg += `【AFAD（実計測CV）】\n`;
    const cvCells    = afad.cells.filter(c => /^\d+$/.test(c) && parseInt(c) < 500);
    const spendCells = afad.cells.filter(c => /^[\d,]+$/.test(c) && parseInt(c.replace(/,/g, '')) > 10000);
    msg += cvCells[0]    ? `　獲得CV：${cvCells[0]}件\n`    : `　獲得CV：取得中\n`;
    msg += spendCells[0] ? `　広告費：¥${spendCells[0]}\n` : ``;
    const cv    = parseInt(cvCells[0] || '0');
    const spend = parseInt((spendCells[0] || '').replace(/,/g, ''));
    if (spend > 0 && cv > 0) {
      msg += `　CPA：${yen(spend / cv)}\n`;
    }
  } else {
    msg += `【AFAD（実計測CV）】\n　データ取得できませんでした\n`;
  }

  console.log('📤 送信メッセージ:\n' + msg);
  await sendSlack(msg);
  console.log('✅ 速報レポート送信完了');
}

main().catch(e => {
  console.error('❌ エラー:', e);
  process.exit(1);
});

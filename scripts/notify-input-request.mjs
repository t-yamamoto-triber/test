#!/usr/bin/env node
/**
 * rawデータ更新完了後に料率入力依頼を Chatwork/Slack に送信する
 */
import { notify } from './notifier.mjs';

const INPUT_URL = 'https://ad-report-design.surge.sh/input.html';

function getYesterdayJST() {
  const now  = new Date(Date.now() + 9 * 3600 * 1000);
  const yest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return `${yest.getUTCFullYear()}年${yest.getUTCMonth() + 1}月${yest.getUTCDate()}日`;
}

const dateStr = getYesterdayJST();
const message =
  `[info][title]📊 ${dateStr} 料率入力の依頼[/title]` +
  `本日分の料率を入力してください。\n\n${INPUT_URL}[/info]`;

notify(message)
  .then(() => console.log(`✅ 料率入力依頼を送信しました（${dateStr}）`))
  .catch(err => { console.error('❌ エラー:', err.message); process.exit(1); });

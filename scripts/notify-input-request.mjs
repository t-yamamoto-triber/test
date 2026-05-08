#!/usr/bin/env node
/**
 * rawデータ更新完了後に料率入力依頼を Chatwork に送信する
 * upload-raw-data.yml の最後のステップから呼ばれる
 */

const CHATWORK_TOKEN = process.env.CHATWORK_TOKEN;
const CHATWORK_ROOM  = process.env.CHATWORK_ROOM_ID;
const INPUT_URL      = 'https://ad-report-design.surge.sh/input.html';

if (!CHATWORK_TOKEN || !CHATWORK_ROOM) {
  console.error('❌ 環境変数 CHATWORK_TOKEN / CHATWORK_ROOM_ID が未設定');
  process.exit(1);
}

// JST で「前日」の日付文字列を返す（0時台に実行されるため前日 = データ対象日）
function getYesterdayJST() {
  const now  = new Date(Date.now() + 9 * 3600 * 1000); // UTC → JST
  const yest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return `${yest.getUTCFullYear()}年${yest.getUTCMonth() + 1}月${yest.getUTCDate()}日`;
}

async function notify() {
  const dateStr = getYesterdayJST();
  const message =
    `[info][title]📊 ${dateStr} 料率入力の依頼[/title]` +
    `本日分の料率を入力してください。\n\n${INPUT_URL}[/info]`;

  const res = await fetch(`https://api.chatwork.com/v2/rooms/${CHATWORK_ROOM}/messages`, {
    method: 'POST',
    headers: {
      'X-ChatWorkToken': CHATWORK_TOKEN,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `body=${encodeURIComponent(message)}`
  });

  const json = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`✅ 料率入力依頼を送信しました（${dateStr}）`);
  } else {
    console.error('❌ Chatwork 送信失敗:', res.status, json);
    process.exit(1);
  }
}

notify().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});

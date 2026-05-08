/**
 * 通知ユーティリティ
 * CHATWORK_TOKEN / SLACK_WEBHOOK_URL が設定されていれば両方に送信
 */

// ── Chatwork ──────────────────────────────────────────────────────────
async function sendChatwork(text) {
  const token  = process.env.CHATWORK_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;
  if (!token || !roomId) return;

  await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'X-ChatWorkToken': token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `body=${encodeURIComponent(text)}`
  }).catch(e => console.error('Chatwork送信エラー:', e.message));
}

async function sendChatworkFile(messageText, fileBuffer, filename = 'file.png') {
  const token  = process.env.CHATWORK_TOKEN;
  const roomId = process.env.CHATWORK_ROOM_ID;
  if (!token || !roomId) return;

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const messagePart =
    `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${messageText}\r\n`;
  const filePart =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`;
  const ending = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(messagePart, 'utf8'),
    Buffer.from(filePart, 'utf8'),
    fileBuffer,
    Buffer.from(ending, 'utf8')
  ]);

  await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/files`, {
    method: 'POST',
    headers: { 'X-ChatWorkToken': token, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  }).catch(e => console.error('Chatworkファイル送信エラー:', e.message));
}

// ── Slack ─────────────────────────────────────────────────────────────
function toSlackText(cwText) {
  // Chatwork の [info][title]タイトル[/title]本文[/info] を Slack 形式に変換
  return cwText
    .replace(/\[info\]\[title\]([\s\S]*?)\[\/title\]([\s\S]*?)\[\/info\]/g,
      (_, title, body) => `*${title.trim()}*\n${body.trim()}`)
    .replace(/\[info\]([\s\S]*?)\[\/info\]/g, '$1')
    .trim();
}

async function sendSlack(text) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: toSlackText(text) })
  }).catch(e => console.error('Slack送信エラー:', e.message));
}

// ── 公開 API ──────────────────────────────────────────────────────────

/**
 * テキストメッセージを両方に送信
 */
export async function notify(text) {
  await Promise.all([
    sendChatwork(text),
    sendSlack(text)
  ]);
}

/**
 * ファイル（画像）付きメッセージを送信
 * Chatwork: ファイルアップロード
 * Slack: テキストのみ（Webhook はファイル非対応のため）
 */
export async function notifyWithFile(messageText, fileBuffer, filename = 'ad-report.png') {
  await Promise.all([
    sendChatworkFile(messageText, fileBuffer, filename),
    sendSlack(messageText + '\n※ 画像はChatworkをご確認ください')
  ]);
}

/**
 * 通知ユーティリティ
 * Chatwork  : CHATWORK_TOKEN + CHATWORK_ROOM_ID
 * Slack     : SLACK_BOT_TOKEN + SLACK_CHANNEL_ID（テキスト・ファイル両対応）
 * 設定されているサービスにだけ送信する（未設定はスキップ）
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
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) return;

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text: toSlackText(text) })
  }).catch(e => console.error('Slack送信エラー:', e.message));
}

/**
 * Slack にファイルをアップロードして投稿する（Bot Token 方式）
 * 必要な env: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */
async function sendSlackFile(messageText, fileBuffer, filename = 'ad-report.png') {
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!token || !channel) {
    // Bot Token 未設定の場合は Webhook でテキストのみ送信
    await sendSlack(messageText);
    return;
  }

  try {
    // Step 1: アップロード用 URL を取得
    const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, length: fileBuffer.length })
    });
    const { ok: ok1, upload_url, file_id, error: e1 } = await urlRes.json();
    if (!ok1) throw new Error(`getUploadURLExternal: ${e1}`);

    // Step 2: ファイルデータを PUT
    await fetch(upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBuffer
    });

    // Step 3: アップロード完了 & チャンネルへ投稿
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: file_id }],
        channel_id: channel,
        initial_comment: toSlackText(messageText)
      })
    });
    const { ok: ok3, error: e3 } = await completeRes.json();
    if (!ok3) throw new Error(`completeUploadExternal: ${e3}`);

    console.log('✅ Slack ファイル送信完了');
  } catch (e) {
    console.error('Slack ファイル送信エラー:', e.message);
  }
}

// ── 公開 API ──────────────────────────────────────────────────────────

/**
 * テキストメッセージを Chatwork / Slack 両方に送信
 */
export async function notify(text) {
  await Promise.all([
    sendChatwork(text),
    sendSlack(text)
  ]);
}

/**
 * ファイル（画像）付きメッセージを送信
 * Chatwork : ファイルアップロード
 * Slack    : SLACK_BOT_TOKEN 設定あり → ファイルアップロード
 *            未設定           → Webhook でテキストのみ
 */
export async function notifyWithFile(messageText, fileBuffer, filename = 'ad-report.png') {
  await Promise.all([
    sendChatworkFile(messageText, fileBuffer, filename),
    sendSlackFile(messageText, fileBuffer, filename)
  ]);
}

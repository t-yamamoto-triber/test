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
 * 画像を一時ホストにアップロードして公開 URL を取得する（複数サービスにフォールバック）
 */
async function uploadToPublicHost(fileBuffer, filename) {
  // transfer.sh: PUT でシンプルアップロード
  const tryTransferSh = async () => {
    const res = await fetch(`https://transfer.sh/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(fileBuffer.length), 'Max-Days': '3' },
      body: fileBuffer
    });
    if (!res.ok) throw new Error(`transfer.sh: ${res.status}`);
    return (await res.text()).trim();
  };

  // catbox.moe: multipart POST
  const tryCatbox = async () => {
    const b = '----CB' + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n--${b}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'),
      fileBuffer,
      Buffer.from(`\r\n--${b}--\r\n`, 'utf8')
    ]);
    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
      body
    });
    const text = (await res.text()).trim();
    if (!text.startsWith('https://')) throw new Error(`catbox.moe: ${text}`);
    return text;
  };

  // 0x0.st: multipart POST
  const try0x0 = async () => {
    const b = '----ZX' + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'),
      fileBuffer,
      Buffer.from(`\r\n--${b}--\r\n`, 'utf8')
    ]);
    const res = await fetch('https://0x0.st', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
      body
    });
    if (!res.ok) throw new Error(`0x0.st: ${res.status}`);
    return (await res.text()).trim();
  };

  for (const [name, fn] of [['transfer.sh', tryTransferSh], ['catbox.moe', tryCatbox], ['0x0.st', try0x0]]) {
    try {
      const url = await fn();
      console.log(`Slack: 公開URL取得 (${name}):`, url);
      return url;
    } catch (e) {
      console.warn(`Slack: ${name} 失敗 -`, e.message);
    }
  }
  throw new Error('全ての一時ホストが失敗しました');
}

/**
 * Slack に画像付きメッセージを送信する
 * 公開ホストに一時アップロード → image ブロックで投稿
 */
async function sendSlackFile(messageText, fileBuffer, filename = 'ad-report.png') {
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = (process.env.SLACK_CHANNEL_ID ?? '').trim();
  if (!token || !channel) {
    await sendSlack(messageText);
    return;
  }

  try {
    // 外部ホストに一時アップロードして公開 URL を取得
    console.log('Slack: 画像を一時ホストにアップロード中...');
    const imageUrl = await uploadToPublicHost(fileBuffer, filename);
    console.log('Slack: 公開URL取得:', imageUrl);

    // image ブロックで投稿
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: toSlackText(messageText) } },
          { type: 'image', image_url: imageUrl, alt_text: 'Ad Report Screenshot' }
        ]
      })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`chat.postMessage: ${json.error}`);
    console.log('✅ Slack 画像投稿完了');
  } catch (e) {
    console.error('Slack ファイル送信エラー:', e.message);
    // フォールバック: テキストのみ送信
    await sendSlack(messageText);
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
 *            未設定           → テキストのみ
 */
export async function notifyWithFile(messageText, fileBuffer, filename = 'ad-report.png') {
  await Promise.all([
    sendChatworkFile(messageText, fileBuffer, filename),
    sendSlackFile(messageText, fileBuffer, filename)
  ]);
}

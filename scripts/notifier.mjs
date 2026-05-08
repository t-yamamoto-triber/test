/**
 * 通知ユーティリティ
 * Chatwork  : CHATWORK_TOKEN + CHATWORK_ROOM_ID
 * Slack     : SLACK_BOT_TOKEN + SLACK_CHANNEL_ID（テキスト・ファイル両対応）
 * 設定されているサービスにだけ送信する（未設定はスキップ）
 */
import https from 'https';

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

// https モジュールで PUT（3xx はアップロード成功の合図なのでフォローしない）
function httpsput(url, buffer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length }
    }, res => {
      console.log('Slack Step2 status:', res.statusCode);
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

/**
 * Slack にファイルをアップロードして投稿する
 * Step1: getUploadURLExternal → Step2: PUT → Step3: completeUpload → Step4: chat.postMessage
 */
async function sendSlackFile(messageText, fileBuffer, filename = 'ad-report.png') {
  const token   = process.env.SLACK_BOT_TOKEN;
  const channel = (process.env.SLACK_CHANNEL_ID ?? '').trim();
  if (!token || !channel) {
    await sendSlack(messageText);
    return;
  }

  try {
    // Step 1: アップロード URL を取得
    const step1 = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ filename, length: String(fileBuffer.length) }).toString()
    });
    const body1 = await step1.json();
    if (!body1.ok) throw new Error(`getUploadURLExternal: ${body1.error}`);
    const { upload_url, file_id } = body1;
    console.log('Slack Step1 完了 file_id:', file_id, 'channel:', channel, 'channel.length:', channel.length);

    // Step 2: バイナリを PUT（redirect:manual で 302 をそのまま受け取る）
    const step2res = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(fileBuffer),
      redirect: 'manual'
    }).catch(async () => {
      // fetch が失敗した場合は https モジュールで再試行
      console.log('fetch PUT failed, fallback to https module');
      await httpsput(upload_url, fileBuffer);
      return { status: 302 };
    });
    console.log('Slack Step2 status:', step2res.status);

    // Step 3: アップロード完了 + チャンネルに直接投稿
    const step3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: file_id }],
        channel_id: channel,
        initial_comment: toSlackText(messageText)
      })
    });
    const body3 = await step3.json();
    const uploadedSize = body3.files?.[0]?.size ?? 'unknown';
    const sharedChannels = body3.files?.[0]?.channels ?? [];
    console.log(`Slack Step3: ok=${body3.ok} size=${uploadedSize} channels=${JSON.stringify(sharedChannels)} error=${body3.error ?? ''}`);
    if (!body3.ok) throw new Error(`completeUploadExternal: ${body3.error}`);
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
 *            未設定           → テキストのみ
 */
export async function notifyWithFile(messageText, fileBuffer, filename = 'ad-report.png') {
  await Promise.all([
    sendChatworkFile(messageText, fileBuffer, filename),
    sendSlackFile(messageText, fileBuffer, filename)
  ]);
}

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


/**
 * GitHub Releases に画像をアップロードして公開 URL を返す
 * GITHUB_TOKEN と GITHUB_REPOSITORY は GitHub Actions で自動設定される
 */
async function uploadToGitHubRelease(fileBuffer, filename) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!token || !repo) throw new Error('GITHUB_TOKEN / GITHUB_REPOSITORY が未設定');

  const apiBase = `https://api.github.com/repos/${repo}`;
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'ad-report-bot', Accept: 'application/vnd.github+json' };
  const tagName = 'ad-report-screenshots';

  // タグが存在するか確認（なければ作成）
  let releaseId;
  const getRes = await fetch(`${apiBase}/releases/tags/${tagName}`, { headers });
  if (getRes.ok) {
    const release = await getRes.json();
    releaseId = release.id;
    // 同名の既存アセットを削除
    for (const asset of (release.assets ?? [])) {
      if (asset.name === filename) {
        await fetch(`${apiBase}/releases/assets/${asset.id}`, { method: 'DELETE', headers });
      }
    }
  } else {
    // Release を新規作成
    const createRes = await fetch(`${apiBase}/releases`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tagName, name: 'Ad Report Screenshots', prerelease: true })
    });
    if (!createRes.ok) {
      const err = await createRes.json();
      throw new Error(`release作成失敗: ${err.message}`);
    }
    releaseId = (await createRes.json()).id;
  }

  // アセットをアップロード
  const uploadRes = await fetch(
    `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(filename)}`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(fileBuffer.length) }, body: fileBuffer }
  );
  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({}));
    throw new Error(`asset upload失敗: ${err.message ?? uploadRes.status}`);
  }
  const asset = await uploadRes.json();
  return asset.browser_download_url;
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
    // GitHub Releases に一時アップロードして公開 URL を取得
    console.log('Slack: GitHub Releases に画像アップロード中...');
    const imageUrl = await uploadToGitHubRelease(fileBuffer, filename);
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
 * Slack    : SLACK_BOT_TOKEN 設定あり → ファイルアップロード（slackText があればそちらを使用）
 *            未設定           → テキストのみ
 */
export async function notifyWithFile(messageText, fileBuffer, filename = 'ad-report.png', opts = {}) {
  const slackText = opts.slackText ?? messageText;
  await Promise.all([
    sendChatworkFile(messageText, fileBuffer, filename),
    sendSlackFile(slackText, fileBuffer, filename)
  ]);
}

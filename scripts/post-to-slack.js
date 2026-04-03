#!/usr/bin/env node

/**
 * Post dashboard screenshot to Slack
 *
 * Uploads dashboard screenshot to Slack with summary message
 *
 * Dry run: DRY_RUN=1, DRY_RUN=true, or --dry-run
 *   - Does not post. Prints payload summary.
 *   - If SLACK_BOT_TOKEN is set, calls auth.test only (no channel post).
 */

import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isDryRun() {
  return (
    process.env.DRY_RUN === '1' ||
    process.env.DRY_RUN === 'true' ||
    process.argv.includes('--dry-run')
  );
}

/**
 * Build Slack post payload from local files (no network).
 */
async function buildPostPayload() {
  const dataPath = path.join(__dirname, '..', 'data', 'health-data.json');
  const healthData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));

  const now = new Date(healthData.calculatedAt).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  let dashboardUrl = null;
  try {
    const urlPath = path.join(__dirname, '..', 'data', 'deployed-url.txt');
    dashboardUrl = (await fs.readFile(urlPath, 'utf-8')).trim();
  } catch {
    // skip
  }

  let messageText = `📊 マガジン進捗管理ダッシュボード（${now}）\n\n`;

  if (dashboardUrl) {
    messageText += `🔗 <${dashboardUrl}|ダッシュボードを開く>\n\n`;
  }

  messageText += `*全体健康度*: ${healthData.overallHealth.status} ${healthData.overallHealth.label}`;

  const screenshotPaths = [
    path.join(__dirname, '..', 'output', 'screenshot-1.png'),
    path.join(__dirname, '..', 'output', 'screenshot-2.png'),
    path.join(__dirname, '..', 'output', 'screenshot-3.png')
  ];

  const fileUploads = [];
  for (let i = 0; i < screenshotPaths.length; i++) {
    try {
      await fs.access(screenshotPaths[i]);
      const imageBuffer = await fs.readFile(screenshotPaths[i]);
      fileUploads.push({
        file: imageBuffer,
        filename: `magazine-dashboard-${i + 1}.png`,
        path: screenshotPaths[i],
        sizeBytes: imageBuffer.length
      });
    } catch {
      // missing
    }
  }

  return { messageText, dashboardUrl, fileUploads, healthData };
}

async function postToSlack() {
  const dryRun = isDryRun();

  if (dryRun) {
    console.log('🧪 DRY RUN — Slack には投稿しません\n');
  } else {
    console.log('💬 Slackに投稿中...');
  }

  const channelId = process.env.MAGAZINE_SLACK_CHANNEL_ID;
  if (!channelId) {
    console.error('❌ MAGAZINE_SLACK_CHANNEL_ID が設定されていません');
    console.log('💡 .env ファイルに MAGAZINE_SLACK_CHANNEL_ID=C0XXXXXXXXX を設定してください');
    process.exit(1);
  }

  if (!dryRun && !process.env.MAGAZINE_SLACK_BOT_TOKEN) {
    console.error('❌ MAGAZINE_SLACK_BOT_TOKEN が設定されていません');
    console.log('💡 .env ファイルに MAGAZINE_SLACK_BOT_TOKEN=xoxb-xxxxx を設定してください');
    process.exit(1);
  }

  console.log(`📮 投稿先チャンネル ID: ${channelId}`);

  try {
    const { messageText, dashboardUrl, fileUploads } = await buildPostPayload();

    if (dryRun) {
      console.log('--- 投稿予定の本文 ---');
      console.log(messageText.replace(/<([^|>]+)\|([^>]+)>/g, '$2 ($1)'));
      console.log('---');
      console.log(`ダッシュボードURL: ${dashboardUrl ?? '(なし)'}`);
      console.log(`添付画像: ${fileUploads.length}枚`);
      for (const u of fileUploads) {
        console.log(`  - ${u.filename} (${u.sizeBytes} bytes)`);
      }
      if (fileUploads.length === 0) {
        console.log('  (スクリーンショットなし → テキストのみ投稿の想定)');
      }

      if (process.env.MAGAZINE_SLACK_BOT_TOKEN) {
        const slack = new WebClient(process.env.MAGAZINE_SLACK_BOT_TOKEN);
        const auth = await slack.auth.test();
        if (auth.ok) {
          console.log('\n✅ auth.test OK（トークンは有効）');
          console.log(`   bot: ${auth.user ?? auth.bot_id ?? '—'} / team: ${auth.team ?? '—'}`);
        } else {
          console.log('\n⚠️ auth.test 失敗:', auth.error);
          process.exit(1);
        }
      } else {
        console.log('\n💡 MAGAZINE_SLACK_BOT_TOKEN 未設定のため auth.test はスキップ');
      }

      console.log('\n✅ ドライラン完了');
      return;
    }

    const slack = new WebClient(process.env.MAGAZINE_SLACK_BOT_TOKEN);

    const uploadsForApi = fileUploads.map(({ file, filename }) => ({ file, filename }));

    console.log(`📤 メッセージを投稿中... (画像: ${uploadsForApi.length}枚)`);

    if (uploadsForApi.length > 0) {
      const uploadResult = await slack.files.uploadV2({
        channel_id: channelId,
        file_uploads: uploadsForApi,
        initial_comment: messageText
      });

      if (uploadResult.ok) {
        console.log('✅ 画像アップロード完了');
        console.log('✅ Slackへの投稿が完了しました!');
        console.log(`📍 投稿先チャンネルID: ${channelId}`);

        if (uploadResult.files && uploadResult.files.length > 0) {
          const file = uploadResult.files[0];
          if (file.files && file.files.length > 0 && file.files[0].permalink) {
            console.log(`📎 ファイルURL: ${file.files[0].permalink}`);
          }
        }
        return;
      }
      console.error('⚠️ アップロードエラー:', uploadResult.error);
      process.exit(1);
    }

    console.log('⚠️ スクリーンショットが見つからないため、テキストのみ投稿します');
    const postResult = await slack.chat.postMessage({
      channel: channelId,
      text: messageText
    });

    if (postResult.ok) {
      console.log('✅ Slackへの投稿が完了しました! (テキストのみ)');
      console.log(`📍 投稿先チャンネルID: ${channelId}`);
      return;
    }
    console.error('⚠️ 投稿エラー:', postResult.error);
    process.exit(1);
  } catch (error) {
    console.error('❌ エラーが発生しました:', error.message);

    if (error.data?.error === 'not_in_channel') {
      console.log('💡 ボットをチャンネルに追加してください:');
      console.log(`   /invite @your-bot-name をチャンネルで実行`);
    } else if (error.data?.error === 'channel_not_found') {
      console.log('💡 チャンネルが見つかりません。チャンネルIDを確認してください。');
      console.log('   プライベートチャンネルの場合は、ボットを招待する必要があります。');
    } else if (error.data?.error === 'invalid_auth') {
      console.log('💡 Slack Bot Token が無効です。.env ファイルを確認してください。');
    }

    if (error.stack) {
      console.error(error.stack);
    }

    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  postToSlack();
}

export default postToSlack;

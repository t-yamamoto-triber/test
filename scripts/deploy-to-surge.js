#!/usr/bin/env node

/**
 * Deploy dashboard to Surge.sh
 *
 * Deploys dashboard.html to Surge.sh
 */

import 'dotenv/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function deployToSurge() {
  console.log('🚀 Surge.shにデプロイ中...');

  try {
    // HTMLファイルの存在確認
    const htmlPath = path.join(__dirname, '..', 'output', 'dashboard.html');

    try {
      await fs.access(htmlPath);
    } catch {
      console.error('❌ HTMLファイルが見つかりません:', htmlPath);
      console.log('💡 先に npm run generate-dashboard を実行してください');
      process.exit(1);
    }

    // デプロイ用ディレクトリを準備
    const deployDir = path.join(__dirname, '..', 'dist');
    await fs.mkdir(deployDir, { recursive: true });

    // HTMLファイルをコピー
    const indexPath = path.join(deployDir, 'index.html');
    await fs.copyFile(htmlPath, indexPath);

    // surge.shのドメイン設定 - 固定ドメインを使用
    const domain = process.env.MAGAZINE_SURGE_DOMAIN;
    if (!domain) {
      console.error('❌ MAGAZINE_SURGE_DOMAIN が設定されていません');
      console.log('💡 .env ファイルに MAGAZINE_SURGE_DOMAIN=your-project-dashboard.surge.sh を設定してください');
      process.exit(1);
    }

    console.log(`📝 デプロイ先ドメイン: ${domain}`);

    // Surgeでデプロイ
    console.log('📤 アップロード中...');
    const { stdout, stderr } = await execAsync(
      `npx surge --project "${deployDir}" --domain "${domain}"`,
      {
        env: {
          ...process.env,
          // CI環境でのインタラクティブモードを無効化
          CI: 'true',
          SURGE_LOGIN: process.env.MAGAZINE_SURGE_LOGIN || '',
          SURGE_TOKEN: process.env.MAGAZINE_SURGE_TOKEN || ''
        }
      }
    );

    if (stderr && !stderr.includes('Success')) {
      console.error('⚠️ Surge警告:', stderr);
    }

    const deployedUrl = `https://${domain}`;
    console.log('✅ デプロイ完了!');
    console.log(`🌐 URL: ${deployedUrl}`);

    // URLをファイルに保存（他のスクリプトから参照用）
    const dataDir = path.join(__dirname, '..', 'data');
    await fs.mkdir(dataDir, { recursive: true });

    const urlPath = path.join(dataDir, 'deployed-url.txt');
    await fs.writeFile(urlPath, deployedUrl, 'utf-8');

    return deployedUrl;
  } catch (error) {
    console.error('❌ デプロイエラー:', error.message);

    if (error.message.includes('surge: command not found') || error.message.includes('surge')) {
      console.log('💡 npx surge が実行できません。npm ci を再実行してください。');
    }

    // 認証エラーの場合
    if (error.message.includes('Not authenticated') || error.message.includes('Invalid token')) {
      console.log('\n💡 Surge認証が必要です:');
      console.log('1. npx surge login でログイン');
      console.log('2. または環境変数 SURGE_TOKEN を設定');
      console.log('   トークン取得: npx surge token');
    }

    process.exit(1);
  }
}

// 実行
if (import.meta.url === `file://${process.argv[1]}`) {
  deployToSurge();
}

export default deployToSurge;

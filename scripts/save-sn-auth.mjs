#!/usr/bin/env node
/**
 * スマートニュース管理画面に手動でログインして
 * セッションCookieをGitHub Secretsに保存するスクリプト
 *
 * 実行方法（Mac上で）:
 *   GITHUB_PAT=xxx node scripts/save-sn-auth.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const AUTH_PATH  = path.join(__dirname, '..', 'output', 'sn-auth.json');
const GITHUB_PAT = process.env.GITHUB_PAT;
const REPO       = 't-yamamoto-triber/test';

async function main() {
  console.log('🌐 スマートニュース管理画面を開きます...');
  console.log('👤 メールアドレスを入力して、届いたコードでログインしてください。');
  console.log('✅ ログイン完了後、自動でCookieが保存されます。\n');

  const browser = await chromium.launch({ headless: false }); // 有人操作のため表示
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto('https://accounts.smartnews.com/signIn?idp=email&otpType=code&next=https://ads.smartnews.com/bm/businesses');

  // ログイン完了を待つ（ads.smartnews.com に遷移したら完了）
  console.log('⏳ ログインを待っています...');
  await page.waitForURL('https://ads.smartnews.com/**', { timeout: 300000 }); // 5分待機
  console.log('✅ ログイン完了！Cookieを保存中...');

  // 認証状態を保存
  await fs.mkdir(path.dirname(AUTH_PATH), { recursive: true });
  await context.storageState({ path: AUTH_PATH });
  await browser.close();

  const authState = await fs.readFile(AUTH_PATH, 'utf-8');
  console.log(`📦 Cookie保存: ${AUTH_PATH} (${authState.length} bytes)`);

  // GitHub Secrets に保存（gh CLI 経由）
  console.log('📤 GitHub Secrets に SN_AUTH_STATE を保存中...');
  try {
    execSync(`gh secret set SN_AUTH_STATE --body @${AUTH_PATH} --repo ${REPO}`, {
      stdio: 'inherit'
    });
    console.log('✅ GitHub Secrets 保存完了！');
    // 保存成功後にファイルを削除
    await fs.unlink(AUTH_PATH).catch(() => {});
  } catch {
    // gh CLI が使えない場合：ファイルを残してクリップボードにコピー
    console.log('\n⚠️ gh CLI での自動保存に失敗しました。手動で設定します。');
    try {
      execSync(`cat "${AUTH_PATH}" | pbcopy`);
      console.log('✅ 認証データをクリップボードにコピーしました！');
    } catch {
      console.log(`📋 以下のコマンドで内容を確認できます: cat "${AUTH_PATH}"`);
    }
    console.log('\n以下の手順で GitHub Secrets に登録してください：');
    console.log(`1. https://github.com/${REPO}/settings/secrets/actions を開く`);
    console.log('2. 「New repository secret」をクリック');
    console.log('3. Name: SN_AUTH_STATE');
    console.log('4. Secret: クリップボードの内容をペースト（Cmd+V）');
    console.log('5. 「Add secret」をクリック');
    console.log(`\n⚠️  登録後、必ずこのファイルを削除してください: ${AUTH_PATH}`);
  }

  console.log('\n🎉 完了！次回から自動でスマートニュースにログインできます。');
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});

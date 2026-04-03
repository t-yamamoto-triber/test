#!/usr/bin/env node

import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { STATUS_LABELS } from '../config/settings.js';

import { generateFallbackSuggestions } from './ai-suggestion-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateAISuggestions() {
  console.log('🤖 Gemini APIでAI提案を生成中...');

  // API Key確認
  const apiKey = process.env.MAGAZINE_GEMINI_API_KEY;

  let healthData;
  try {
    const healthDataPath = path.join(__dirname, '..', 'data', 'health-data.json');
    healthData = JSON.parse(await fs.readFile(healthDataPath, 'utf-8'));
  } catch (error) {
    console.error('❌ 健康度データの読み込みに失敗しました:', error.message);
    console.log('💡 先に npm run calculate-health を実行してください');
    process.exit(1);
  }

    console.log('📊 健康度データ読み込み完了:', {
      企画案ストック: healthData.planStockHealth?.stockCount ?? 0,
      構成作成中: healthData.summary['2.構成作成中'] ?? 0,
      原稿執筆中: healthData.summary['3.原稿執筆中'] ?? 0,
      動画編集中: healthData.summary['4.動画編集中'] ?? 0,
      原稿執筆健康度: healthData.manuscriptHealth?.status,
      動画編集健康度: healthData.videoHealth?.status
    });

  let suggestions;
  let source = 'gemini';
  let modelName = null;
  let fallbackReason = null;

  if (!apiKey) {
    console.warn('⚠️  MAGAZINE_GEMINI_API_KEY が設定されていません。フォールバック提案を生成します。');
    suggestions = generateFallbackSuggestions(healthData);
    source = 'fallback';
    fallbackReason = 'APIキー未設定';
  } else {
    try {
      const promptPath = path.join(__dirname, '..', 'config', 'ai-prompts', 'unified.md');
      const promptTemplate = await fs.readFile(promptPath, 'utf-8');

      const context = buildContext(healthData);
      const prompt = promptTemplate.replace('{{CONTEXT}}', context);

      console.log('📝 プロンプト生成完了（文字数:', prompt.length, '）');

      const genAI = new GoogleGenerativeAI(apiKey);
      const preferredModel = process.env.MAGAZINE_GEMINI_MODEL;
      const modelCandidates = [];
      if (preferredModel) {
        modelCandidates.push(preferredModel);
      }

      const defaultModels = [
        'models/gemini-3-flash-preview',
        'models/gemini-2.5-flash',
      ];

      defaultModels.forEach(model => {
        if (!modelCandidates.includes(model)) {
          modelCandidates.push(model);
        }
      });

      let model;
      let lastError;

      for (const candidate of modelCandidates) {
        try {
          modelName = candidate;
          console.log(`📦 モデル候補を初期化: ${modelName}`);
          model = genAI.getGenerativeModel({ model: modelName });
          console.log('🚀 Gemini API にリクエスト送信中...');
          const result = await model.generateContent(prompt);
          const response = await result.response;
          const text = response.text();
          console.log('✅ Geminiからレスポンスを受信（文字数:', text.length, '）');

          const parsedSuggestions = parseAISuggestions(text);
          if (!Array.isArray(parsedSuggestions) || parsedSuggestions.length !== 3) {
            throw new Error(`AI提案の形式が不正です。3つの提案が必要ですが、${parsedSuggestions?.length ?? 0}個でした。`);
          }

          suggestions = parsedSuggestions;
          lastError = null;
          break;
        } catch (error) {
          console.warn(`⚠️  モデル ${modelName} の呼び出しに失敗しました: ${error.message}`);
          lastError = error;
          model = null;
        }
      }

      if (!suggestions) {
        throw lastError || new Error('利用可能なGeminiモデルでの生成に失敗しました');
      }
    } catch (error) {
      console.error('⚠️  Gemini APIの呼び出しに失敗しました:', error.message);
      if (error.stack) {
        console.error('スタックトレース:', error.stack);
      }
      suggestions = generateFallbackSuggestions(healthData);
      source = 'fallback';
      fallbackReason = error.message;
    }
  }

  if (!Array.isArray(suggestions) || suggestions.length !== 3) {
    console.warn('⚠️  フォールバック生成の結果が不足していたため、デフォルト提案を再生成します。');
    suggestions = generateFallbackSuggestions(healthData);
    source = 'fallback';
    fallbackReason = fallbackReason || 'フォールバック再生成';
  }

  const outputDir = path.join(__dirname, '..', 'data');
  await fs.mkdir(outputDir, { recursive: true });

  const outputData = {
    generatedAt: new Date().toISOString(),
    source,
    model: source === 'gemini' ? modelName : null,
    note: fallbackReason || undefined,
    suggestions
  };

  const outputPath = path.join(outputDir, 'ai-suggestions.json');
  await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');

  if (source === 'fallback') {
    console.log('✅ フォールバック提案を保存しました:', outputPath);
    if (fallbackReason) {
      console.log('ℹ️  フォールバック理由:', fallbackReason);
    }
  } else {
    console.log('✅ Gemini生成のAI提案を保存しました:', outputPath);
  }

  console.log('\n🎯 生成されたAI提案:');
  suggestions.forEach((suggestion, index) => {
    console.log(`\n${index + 1}. ${suggestion.priorityLabel}`);
    console.log(`   問題: ${suggestion.problem}`);
    console.log(`   アクション:\n${suggestion.action.split('\n').map(line => `   ${line}`).join('\n')}`);
  });
  console.log('');

  return outputPath;
}

/**
 * 健康度データから AI用のコンテキストを生成
 */
function buildContext(healthData) {
  const lines = [];

  const planStock = healthData.planStockHealth || {};
  const composition = healthData.compositionHealth || {};

  lines.push('### 企画案ストック');
  lines.push(`- **ストック数**: ${planStock.stockCount ?? 0}件`);
  lines.push(`- **今週の新規追加**: ${planStock.weeklyNewCount ?? 0} / ${planStock.weeklyTarget ?? 2}件`);
  lines.push(`- **健康度**: ${planStock.status} ${planStock.label}`);
  if (planStock.shortReason) {
    lines.push(`- **詳細**: ${planStock.shortReason}`);
  }
  lines.push('');

  lines.push('### 構成作成');
  lines.push(`- **完了数**: ${composition.completedCount ?? 0} / ${composition.target ?? 3}本`);
  lines.push(`- **健康度**: ${composition.status} ${composition.label}`);
  if (composition.shortReason) {
    lines.push(`- **詳細**: ${composition.shortReason}`);
  }
  lines.push('');

  lines.push('### 原稿執筆中のマガジン');
  const manuscriptCount = healthData.summary?.['3.原稿執筆中'] || 0;
  lines.push(`- **件数**: ${manuscriptCount}件`);
  lines.push(`- **健康度**: ${healthData.manuscriptHealth?.status} ${healthData.manuscriptHealth?.label}`);
  if (healthData.manuscriptHealth?.details) {
    lines.push(`- **詳細**: ${healthData.manuscriptHealth.details}`);
  }

  const manuscripts = healthData.magazines.filter(m =>
    m.label === STATUS_LABELS.manuscript && m.state?.type !== 'completed'
  );
  if (manuscripts.length > 0) {
    lines.push('- **マガジン一覧**:');
    manuscripts.forEach(mag => {
      const statusInfo = mag.displayHealthStatus?.message || '期限内';
      lines.push(`  - 【${mag.title}】${mag.displayHealthStatus?.status || '🟢'} ${statusInfo}`);
    });
  }
  lines.push('');

  lines.push('### 動画編集中のマガジン');
  const videoCount = healthData.summary?.['4.動画編集中'] || 0;
  lines.push(`- **件数**: ${videoCount}件`);
  lines.push(`- **健康度**: ${healthData.videoHealth?.status} ${healthData.videoHealth?.label}`);
  if (healthData.videoHealth?.details) {
    lines.push(`- **詳細**: ${healthData.videoHealth.details}`);
  }

  const videos = healthData.magazines.filter(m =>
    m.label === STATUS_LABELS.video && m.state?.type !== 'completed'
  );
  if (videos.length > 0) {
    lines.push('- **マガジン一覧**:');
    videos.forEach(mag => {
      const statusInfo = mag.displayHealthStatus?.message || '期限内';
      lines.push(`  - 【${mag.title}】${mag.displayHealthStatus?.status || '🟢'} ${statusInfo}`);
    });
  }
  lines.push('');

  lines.push('### その他の統計');
  lines.push(`- **全マガジン数**: ${healthData.magazines.length}件`);
  lines.push(`- **生成日時**: ${new Date(healthData.calculatedAt).toLocaleString('ja-JP')}`);

  return lines.join('\n');
}

/**
 * Geminiのレスポンスから JSON を抽出してパース
 */
function parseAISuggestions(text) {
  // コードブロックを除去
  let jsonText = text.trim();

  // ```json ... ``` または ``` ... ``` を除去
  jsonText = jsonText.replace(/^```json?\s*\n?/gm, '');
  jsonText = jsonText.replace(/\n?```\s*$/gm, '');

  // 余計な前後のテキストを除去（JSON配列の開始/終了を見つける）
  const jsonStart = jsonText.indexOf('[');
  const jsonEnd = jsonText.lastIndexOf(']');

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('JSONが見つかりませんでした。レスポンス: ' + text.substring(0, 500));
  }

  jsonText = jsonText.substring(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(jsonText);
    return parsed;
  } catch (error) {
    console.error('JSON パースエラー:', error.message);
    console.error('パース対象のテキスト:', jsonText.substring(0, 1000));
    throw new Error('JSONのパースに失敗しました: ' + error.message);
  }
}

// 実行
if (import.meta.url === `file://${process.argv[1]}`) {
  generateAISuggestions();
}

export default generateAISuggestions;

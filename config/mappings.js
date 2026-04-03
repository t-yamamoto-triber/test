import { TITLE_EMOJI_RULES } from './settings.js';

// 部分一致で判定（ユーザー名のどこかに含まれればマッチ）
// あなたのチームメンバーに合わせて変更してください
export const ASSIGNEE_MAPPINGS_INCLUDE = {
  'taro_yamada': '山田',
  'hanako_sato': '佐藤',
};

// 前方一致で判定（ユーザー名の先頭が一致すればマッチ）
export const ASSIGNEE_MAPPINGS_STARTS_WITH = {
  'jiro': '田中',
};

/**
 * 担当者名を表示名に変換
 */
export function convertAssigneeName(assigneeName) {
  if (!assigneeName) {
    return '未割当';
  }

  const lowerName = assigneeName.toLowerCase();

  // 部分一致チェック
  for (const [key, displayName] of Object.entries(ASSIGNEE_MAPPINGS_INCLUDE)) {
    if (lowerName.includes(key)) {
      return displayName;
    }
  }

  // 前方一致チェック
  for (const [key, displayName] of Object.entries(ASSIGNEE_MAPPINGS_STARTS_WITH)) {
    if (lowerName.startsWith(key)) {
      return displayName;
    }
  }

  return assigneeName;
}

/**
 * タイトルの装飾をルールに基づいて絵文字に変換
 */
export function convertTitleEmoji(title) {
  let converted = title;
  for (const rule of TITLE_EMOJI_RULES) {
    converted = converted.replace(rule.pattern, rule.emoji);
  }
  return converted;
}

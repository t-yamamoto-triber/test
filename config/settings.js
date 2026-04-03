import 'dotenv/config';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';
export const LINEAR_TEAM_KEY = process.env.MAGAZINE_LINEAR_TEAM_KEY || 'YOUR_TEAM';

export const LABEL_GROUPS = {
  parentStatus: 'マガジン作成ステータス（イシュー）',
  // Linear 上のラベル名が「スタータス」表記のため、そのまま記載
  subIssueStatus: 'マガジン作成スタータス詳細（サブイシュー）',
};

export const STATUS_LABELS = {
  stock: '1.企画案ストック',
  composition: '2.構成作成中',
  manuscript: '3.原稿執筆中',
  video: '4.動画編集中',
};

// 隔週サイクル計算の基準日（月曜日）。自分のプロジェクトに合わせて変更してください
export const BIWEEKLY_EPOCH = new Date(2026, 0, 5);

// タイトルの装飾変換ルール。自分のプロジェクトに合わせて変更してください
export const TITLE_EMOJI_RULES = [
  { pattern: /【通常[^】]*】/g, emoji: '☕' },
  { pattern: /【(トピック|ニュース)[^】]*】/g, emoji: '🌐' },
  { pattern: /【教養[^】]*】/g, emoji: '🌐' },
];

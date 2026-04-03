import { convertAssigneeName } from '../config/mappings.js';

function cleanTitle(title) {
  if (!title) {
    return 'タイトル未設定';
  }
  return title.replace(/\s+/g, ' ').trim();
}

function formatBulletLines(lines) {
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `• ${line}`)
    .join('\n');
}

function listMagazineSamples(magazines, limit = 3) {
  if (!magazines || magazines.length === 0) {
    return '';
  }
  const names = magazines.slice(0, limit).map(m => `「${cleanTitle(m.title)}」`);
  if (magazines.length > limit) {
    return `${names.join('、')} など${magazines.length}件`;
  }
  return names.join('、');
}

export function generateFallbackSuggestions(healthData) {
  const magazines = Array.isArray(healthData?.magazines) ? healthData.magazines : [];
  const activeMagazines = magazines.filter(mag => mag.state?.type !== 'completed');

  const redMagazines = activeMagazines.filter(mag => mag.displayHealthStatus?.status === '🔴');
  const yellowMagazines = activeMagazines.filter(mag => mag.displayHealthStatus?.status === '🟡');
  const deadlineNotSetMagazines = activeMagazines.filter(mag => mag.displayHealthStatus?.isDeadlineNotSet);

  const manuscriptCount = healthData?.summary?.['3.原稿執筆中'] ?? 0;
  const videoCount = healthData?.summary?.['4.動画編集中'] ?? 0;
  const stockCount = healthData?.planStockHealth?.stockCount ?? 0;

  const highSuggestion = buildHighPrioritySuggestion({
    redMagazines,
    deadlineNotSetMagazines,
    yellowMagazines
  });

  const mediumSuggestion = buildMediumPrioritySuggestion({
    healthData,
    redMagazines,
    yellowMagazines,
    highFocusIds: new Set(highSuggestion.focusIds)
  });

  const lowSuggestion = buildLowPrioritySuggestion({
    stockCount,
    healthData,
    manuscriptCount,
    videoCount
  });

  return [highSuggestion.payload, mediumSuggestion.payload, lowSuggestion.payload];
}

function buildHighPrioritySuggestion({ redMagazines, deadlineNotSetMagazines, yellowMagazines }) {
  const focusIds = [];

  if (redMagazines.length > 0) {
    const target = redMagazines[0];
    focusIds.push(target.id);
    const detail = target.displayHealthStatus?.message || '重大な遅延';
    const assignee = convertAssigneeName(target.assignee?.name);

    return {
      focusIds,
      payload: {
        priority: 'high',
        priorityLabel: '優先度：高',
        problem: `「${cleanTitle(target.title)}」で${detail}が発生しており、公開計画に直結するリスクがあります。`,
        action: formatBulletLines([
          `${assignee} と今日中に状況ヒアリングを行い、ブロッカーを特定する`,
          '必要があればリソース追加やスケジュール再調整を即時に決める',
          '対応策と更新後の公開予定日をSlack #your-channel で共有する'
        ])
      }
    };
  }

  if (deadlineNotSetMagazines.length > 0) {
    const target = deadlineNotSetMagazines[0];
    focusIds.push(target.id);
    const assignee = convertAssigneeName(target.assignee?.name);

    return {
      focusIds,
      payload: {
        priority: 'high',
        priorityLabel: '優先度：高',
        problem: `「${cleanTitle(target.title)}」で期限未設定のタスクが残っており、遅延リスクが顕在化しています。`,
        action: formatBulletLines([
          `${assignee} と本日中に期限を設定し、工程表を最新化する`,
          '期限設定後に関係者へ確認依頼を送り、認識を揃える',
          'リマインダー設定やタスク分割で再発防止策を入れる'
        ])
      }
    };
  }

  if (yellowMagazines.length > 0) {
    const target = yellowMagazines[0];
    focusIds.push(target.id);
    const detail = target.displayHealthStatus?.message || '軽微な遅延';
    const assignee = convertAssigneeName(target.assignee?.name);

    return {
      focusIds,
      payload: {
        priority: 'high',
        priorityLabel: '優先度：高',
        problem: `注意ステータスのマガジン（例：${listMagazineSamples([target], 1)}）があり、進行に黄信号が出ています。`,
        action: formatBulletLines([
          `${assignee} に48時間以内の巻き返しプランを依頼する`,
          `遅延内容（${detail}）の解消に必要な支援を洗い出す`,
          '進捗確認の頻度を一時的に上げ、対応状況を追跡する'
        ])
      }
    };
  }

  return {
    focusIds,
    payload: {
      priority: 'high',
      priorityLabel: '優先度：高',
      problem: '重大な遅延は発生していませんが、本日中に重要工程の進行確認を行うと安心です。',
      action: formatBulletLines([
        '原稿・動画それぞれの最優先マガジンについて担当者に現状確認を行う',
        '公開予定日が近い案件のリスク要因を共有し先手の支援を検討する',
        '夕方時点で進捗サマリーをSlackに投稿し、チームで状況を可視化する'
      ])
    }
  };
}

function buildMediumPrioritySuggestion({ healthData, redMagazines, yellowMagazines, highFocusIds }) {
  const remainingYellow = yellowMagazines.filter(mag => !highFocusIds.has(mag.id));
  const manuscriptStatus = healthData?.manuscriptHealth?.status;
  const videoStatus = healthData?.videoHealth?.status;

  if (remainingYellow.length > 0) {
    return {
      payload: {
        priority: 'medium',
        priorityLabel: '優先度：中',
        problem: `注意ステータスのマガジンが${remainingYellow.length}件あり、短期的なフォローが必要です。`,
        action: formatBulletLines([
          `${listMagazineSamples(remainingYellow)} の担当者と今週中にフォロー面談を設定する`,
          '遅延要因と必要なサポートを洗い出し、ToDo化して共有する',
          'タスク完了までのマイルストーンを整理し、進捗トラッキングを強化する'
        ])
      }
    };
  }

  if (manuscriptStatus === '🟡' || videoStatus === '🟡') {
    const targetPhase = manuscriptStatus === '🟡' ? '原稿工程' : '動画工程';
    return {
      payload: {
        priority: 'medium',
        priorityLabel: '優先度：中',
        problem: `${targetPhase}が注意ステータスのため、今週中のリカバリー計画立案が効果的です。`,
        action: formatBulletLines([
          `${targetPhase}のボトルネック工程を特定し、担当者とのタスク分担を見直す`,
          '必要なレビュー枠や外部リソース活用可否を検討する',
          'リカバリー計画をチームドキュメント化し、朝会で共有する'
        ])
      }
    };
  }

  if (redMagazines.length > 1) {
    return {
      payload: {
        priority: 'medium',
        priorityLabel: '優先度：中',
        problem: `複数マガジンで深刻な遅延が見られるため、週内に原因分析と予防策整理が必要です。`,
        action: formatBulletLines([
          '遅延案件ごとに原因カテゴリを分類し、再発防止策を洗い出す',
          '来週以降のリソース計画を再調整し、リードタイムを確保する',
          '改善策と意思決定事項をNotion/Slackで共有して定着させる'
        ])
      }
    };
  }

  return {
    payload: {
      priority: 'medium',
      priorityLabel: '優先度：中',
      problem: '全体的に順調なものの、今週中に工程間の引き継ぎ手順を見直すと効率が向上します。',
      action: formatBulletLines([
        '原稿→動画の引き継ぎフォーマットを確認し、必要ならテンプレートを更新する',
        '来週公開予定のマガジンについて動画チームへ早期に素材共有する',
        '工程レビューの定例化やチェックリスト整備を検討する'
      ])
    }
  };
}

function buildLowPrioritySuggestion({ stockCount, healthData, manuscriptCount, videoCount }) {
  const stockStatus = healthData?.planStockHealth?.status;

  if (stockStatus !== '🟢') {
    return {
      payload: {
        priority: 'low',
        priorityLabel: '優先度：低',
        problem: `企画ストックが${stockCount}件で安定ラインを下回りつつあるため、来月に向けた仕込みが必要です。`,
        action: formatBulletLines([
          '来週の企画会議で優先テーマ候補を3件以上ピックアップする',
          '過去のヒット企画を分析し、再現性のある型を整理する',
          '外部ライターやパートナーの候補を洗い出し、接点作りを進める'
        ])
      }
    };
  }

  if (manuscriptCount > videoCount + 2) {
    return {
      payload: {
        priority: 'low',
        priorityLabel: '優先度：低',
        problem: `原稿工程に対して動画工程の着手数が少なく、今後の滞留リスクがあります。`,
        action: formatBulletLines([
          '動画着手準備が整っているマガジンを棚卸しし、編集チームへ共有する',
          '動画工程の所要日数を見直し、平準化に向けた目安を設定する',
          '外部編集リソースの追加やテンプレート整備を検討する'
        ])
      }
    };
  }

  return {
    payload: {
      priority: 'low',
      priorityLabel: '優先度：低',
      problem: '全体進行は安定しているため、長期的な改善としてナレッジ蓄積を進める余地があります。',
      action: formatBulletLines([
        '今月の成功事例を1本選び、ベストプラクティスをドキュメント化する',
        '健康度の推移を見える化し、定例で振り返れるダッシュボード項目を検討する',
        'AI提案のヒット率を記録し、プロンプト改善のPDCAを回す'
      ])
    }
  };
}

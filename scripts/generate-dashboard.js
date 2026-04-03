#!/usr/bin/env node

/**
 * Generate HTML dashboard from health data
 *
 * Takes health-data.json and generates an HTML dashboard with:
 * - Health indicator section (overall + categories)
 * - Magazine status section (manuscript + video columns)
 * - Calendar section (2 weeks before/after)
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertAssigneeName, convertTitleEmoji } from '../config/mappings.js';
import { LABEL_GROUPS, STATUS_LABELS } from '../config/settings.js';
import { generateFallbackSuggestions } from './ai-suggestion-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Format date as YYYY/MM/DD
 */
function formatDate(dateStr) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * Format date as M/D
 */
function formatDateShort(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${month}/${day}`;
}


/**
 * Generate health section HTML
 */
function generateHealthSection(healthData) {
  const { overallHealth, planStockHealth, compositionHealth, manuscriptHealth, videoHealth, thresholds, magazines } = healthData;

  const getHealthLabelClass = (label) => {
    if (label === '順調') return 'good';
    if (label === '注意') return 'warning';
    if (label === '危険') return 'danger';
    return '';
  };

  const manuscriptMagazines = magazines.filter(m => m.label === STATUS_LABELS.manuscript && m.state?.type !== 'completed');
  const manuscriptOverdue = manuscriptMagazines.filter(m =>
    (m.displayHealthStatus?.status === '🔴' || m.displayHealthStatus?.status === '🟡') &&
    !m.displayHealthStatus?.isDeadlineNotSet
  ).length;
  const manuscriptDeadlineNotSet = manuscriptMagazines.filter(m => m.displayHealthStatus?.isDeadlineNotSet).length;
  const manuscriptOnTime = manuscriptMagazines.filter(m => m.displayHealthStatus?.status === '🟢').length;

  const videoMagazines = magazines.filter(m => m.label === STATUS_LABELS.video && m.state?.type !== 'completed');
  const videoOverdue = videoMagazines.filter(m =>
    (m.displayHealthStatus?.status === '🔴' || m.displayHealthStatus?.status === '🟡') &&
    !m.displayHealthStatus?.isDeadlineNotSet
  ).length;
  const videoDeadlineNotSet = videoMagazines.filter(m => m.displayHealthStatus?.isDeadlineNotSet).length;
  const videoOnTime = videoMagazines.filter(m => m.displayHealthStatus?.status === '🟢').length;

  const manuscriptDetailParts = [];
  if (manuscriptOverdue > 0) manuscriptDetailParts.push(`期限切れ：${manuscriptOverdue}件`);
  if (manuscriptDeadlineNotSet > 0) manuscriptDetailParts.push(`期限未設定：${manuscriptDeadlineNotSet}件`);
  manuscriptDetailParts.push(`期限内：${manuscriptOnTime}件`);
  const manuscriptDetailText = '（' + manuscriptDetailParts.join('　') + '）';

  const videoDetailParts = [];
  if (videoOverdue > 0) videoDetailParts.push(`期限切れ：${videoOverdue}件`);
  if (videoDeadlineNotSet > 0) videoDetailParts.push(`期限未設定：${videoDeadlineNotSet}件`);
  videoDetailParts.push(`期限内：${videoOnTime}件`);
  const videoDetailText = '（' + videoDetailParts.join('　') + '）';

  const overallDetailsHtml = (overallHealth.details || '').replace(/\n/g, '<br>');

  return `
        <!-- 1. 進捗健康度（最上部） -->
        <div class="health-status">
            <h2>💊 進捗健康度</h2>

            <!-- 全体の健康状態 -->
            <div class="health-overall">
                <h3>全体</h3>
                <div class="health-indicator">${overallHealth.status}</div>
                <div class="health-label ${getHealthLabelClass(overallHealth.label)}">${overallHealth.label}</div>
                <div class="health-detail">
                    ${overallDetailsHtml}
                </div>
            </div>

            <!-- カテゴリ別の健康状態 (2x2) -->
            <div class="health-grid">
                <div class="health-card">
                    <h3>企画案ストック</h3>
                    <div class="health-indicator">${planStockHealth.status}</div>
                    <div class="health-label ${getHealthLabelClass(planStockHealth.label)}">${planStockHealth.label}</div>
                    <div class="health-detail">
                        今週の新規追加：${planStockHealth.weeklyNewCount ?? 0} / ${planStockHealth.weeklyTarget ?? 2}件<br>
                        ストック数：${planStockHealth.stockCount ?? 0}件
                    </div>
                </div>

                <div class="health-card">
                    <h3>構成作成</h3>
                    <div class="health-indicator">${compositionHealth.status}</div>
                    <div class="health-label ${getHealthLabelClass(compositionHealth.label)}">${compositionHealth.label}</div>
                    <div class="health-detail">
                        ${compositionHealth.details}<br>
                        <span style="font-size: 0.85em; color: #bbb;">${compositionHealth.cyclePeriod || ''}</span>
                    </div>
                </div>

                <div class="health-card">
                    <h3>原稿執筆</h3>
                    <div class="health-indicator">${manuscriptHealth.status}</div>
                    <div class="health-label ${getHealthLabelClass(manuscriptHealth.label)}">${manuscriptHealth.label}</div>
                    <div class="health-detail">
                        原稿執筆中：${manuscriptMagazines.length}件<br>
                        ${manuscriptDetailText}
                    </div>
                </div>

                <div class="health-card">
                    <h3>動画編集</h3>
                    <div class="health-indicator">${videoHealth.status}</div>
                    <div class="health-label ${getHealthLabelClass(videoHealth.label)}">${videoHealth.label}</div>
                    <div class="health-detail">
                        動画編集中：${videoMagazines.length}件<br>
                        ${videoDetailText}
                    </div>
                </div>
            </div>

            <!-- 判断基準（原稿・動画のみ） -->
            <div class="health-criteria">
                <div style="text-align: center;">
                    <div style="font-weight: 600; color: #666; margin-bottom: 8px;">原稿・動画</div>
                    <div style="display: flex; gap: 15px; justify-content: center; font-size: 0.9em;">
                        <span><span style="font-size: 1.2em;">🟢</span> 期限内</span>
                        <span><span style="font-size: 1.2em;">🟡</span> ${thresholds.delay.warning}日以内遅延</span>
                        <span><span style="font-size: 1.2em;">🔴</span> ${thresholds.delay.warning + 1}日以上遅延</span>
                    </div>
                </div>
            </div>
        </div>
  `;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatActions(actionText) {
  if (!actionText) {
    return '';
  }

  const items = actionText
    .split('\n')
    .map(line => line.replace(/^•\s*/, '').trim())
    .filter(Boolean);

  if (items.length === 0) {
    return '';
  }

  const listItems = items.map(item => `<li>${escapeHtml(item)}</li>`).join('');

  return `
                <div class="suggestion-action">
                    <strong>推奨アクション</strong>
                    <ul>${listItems}</ul>
                </div>
  `;
}

function generateAISuggestionsSection(aiInfo) {
  const suggestions = Array.isArray(aiInfo?.suggestions) ? aiInfo.suggestions : [];

  if (suggestions.length === 0) {
    return `
        <div class="ai-suggestions">
            <h2>AIからの提案</h2>
            <div class="ai-suggestions-note">AI提案データが見つからなかったため、健康度データから推奨事項を生成できませんでした。</div>
        </div>
    `;
  }

  const priorityIcons = {
    high: '🔥',
    medium: '🧭',
    low: '🌱'
  };

  const generatedAt = aiInfo?.generatedAt
    ? new Date(aiInfo.generatedAt).toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : '取得日時不明';

  const sourceLabel = aiInfo?.source === 'gemini'
    ? `Gemini${aiInfo?.model ? ` (${aiInfo.model})` : ''} で生成`
    : '健康度データから自動生成';

  const note = aiInfo?.note ? escapeHtml(String(aiInfo.note).slice(0, 160) + (String(aiInfo.note).length > 160 ? '…' : '')) : '';

  const itemsHTML = suggestions.map(suggestion => {
    const priority = suggestion.priority || 'info';
    const icon = priorityIcons[priority] || '💡';
    const priorityClass = `priority-${priority}`;
    const problem = escapeHtml(suggestion.problem || '状況説明なし');
    const actions = formatActions(suggestion.action);
    const label = escapeHtml(suggestion.priorityLabel || '優先度：情報');

    return `
            <div class="suggestion-item">
                <div class="suggestion-icon">${icon}</div>
                <div class="suggestion-content">
                    <span class="suggestion-priority ${priorityClass}">${label}</span>
                    <h3>${problem}</h3>
                    ${actions}
                </div>
            </div>
    `;
  }).join('');

  return `
        <!-- 2. AIサジェスト -->
        <div class="ai-suggestions">
            <h2>AIからの提案</h2>
            <div class="ai-suggestions-meta">
                <span>${escapeHtml(sourceLabel)}</span>
            </div>
            ${note ? `<div class="ai-suggestions-note">${note}</div>` : ''}
${itemsHTML}
        </div>
  `;
}

/**
 * Generate magazine status section
 */
function generateMagazineStatusSection(healthData) {
  const { magazines } = healthData;

  // Filter by category (exclude completed magazines)
  const manuscriptMagazines = magazines.filter(m =>
    m.label === STATUS_LABELS.manuscript && m.state?.type !== 'completed'
  );
  const videoMagazines = magazines.filter(m =>
    m.label === STATUS_LABELS.video && m.state?.type !== 'completed'
  );

  // Sort by publish date (dueDate) ascending, with null values at the end
  const sortByPublishDate = (a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1; // a is null, move to end
    if (!b.dueDate) return -1; // b is null, move to end
    return new Date(a.dueDate) - new Date(b.dueDate); // ascending order
  };

  manuscriptMagazines.sort(sortByPublishDate);
  videoMagazines.sort(sortByPublishDate);

  // Generate task items (uses pre-calculated displayHealthStatus from health-data.json)
  const generateTaskItems = (magazineList, columnType) => {
    if (magazineList.length === 0) {
      return '<li class="task-item"><div class="task-title">進行中のタスクなし</div></li>';
    }

    // Helper function to determine badge class from status
    const getBadgeClass = (status) => {
      if (status === '🔴') return 'overdue';
      if (status === '🟡') return 'warning';
      return 'good';
    };

    return magazineList.map(magazine => {
      const { title, assignee, currentProcesses, dueDate: publishDate, subIssues, displayHealthStatus } = magazine;

      // Generate delay info from displayHealthStatus (already calculated in calculate-health.js)
      const delayInfo = displayHealthStatus?.message
        ? `<div class="task-detail">${displayHealthStatus.message}</div>`
        : '';

      let dueInfoHTML = '';

      if (columnType === 'manuscript') {
        // 原稿側: 原稿期限 + 公開日

        // Get manuscript due date (2.原稿) for display
        const manuscriptSubs = subIssues.filter(sub =>
          sub.labels && sub.labels.some(label =>
            label.parent &&
            label.parent.name === LABEL_GROUPS.subIssueStatus &&
            label.name.includes('原稿')
          )
        );

        let manuscriptDueDate = null;
        if (manuscriptSubs.length > 0) {
          const subsWithDue = manuscriptSubs.filter(sub => sub.dueDate);
          if (subsWithDue.length > 0) {
            const earliestSub = subsWithDue.reduce((earliest, sub) =>
              new Date(sub.dueDate) < new Date(earliest.dueDate) ? sub : earliest
            );
            manuscriptDueDate = earliestSub.dueDate;
          }
        }

        const manuscriptDueStr = manuscriptDueDate
          ? formatDateShort(new Date(manuscriptDueDate))
          : '未設定';

        const publishDueStr = publishDate ? formatDateShort(new Date(publishDate)) : '未設定';

        // Badge colors based on displayHealthStatus
        const badgeClass = getBadgeClass(displayHealthStatus?.status);
        const manuscriptDueClass = !manuscriptDueDate ? 'overdue' : badgeClass;
        const publishDueClass = !publishDate ? 'overdue' : badgeClass;

        dueInfoHTML = `
          <span class="task-due ${manuscriptDueClass}"><span class="due-label">原稿期限:</span>${manuscriptDueStr}</span>
          <span class="task-due ${publishDueClass}"><span class="due-label">公開日:</span>${publishDueStr}</span>
        `;

      } else if (columnType === 'video') {
        // 動画側: 公開日のみ

        const publishDueStr = publishDate ? formatDateShort(new Date(publishDate)) : '未設定';

        // Badge color based on displayHealthStatus
        const publishDueClass = !publishDate ? 'overdue' : getBadgeClass(displayHealthStatus?.status);

        dueInfoHTML = `<span class="task-due ${publishDueClass}"><span class="due-label">公開日:</span>${publishDueStr}</span>`;
      }

      // Generate status label badges (only if labels exist)
      const statusLabelsHTML = currentProcesses && currentProcesses.length > 0
        ? currentProcesses.map(label =>
            `<span class="task-current-process">${label}</span>`
          ).join('')
        : '';

      return `
                            <li class="task-item">
                                <div class="task-title">${convertTitleEmoji(title)}</div>
                                <div class="task-meta">
                                    <span class="task-assignee">${convertAssigneeName(assignee?.name)}</span>
                                    ${statusLabelsHTML}
                                    ${dueInfoHTML}
                                </div>
                                ${delayInfo}
                            </li>
      `;
    }).join('');
  };

  return `
        <!-- 3. マガジン別ステータス -->
        <div class="details-section">
            <h2>📋 マガジン別ステータス</h2>

            <!-- 凡例 -->
            <div class="status-legend">
                <div class="legend-item">
                    <div class="legend-dot good"></div>
                    <span class="legend-label">期限内</span>
                </div>
                <div class="legend-item">
                    <div class="legend-dot warning"></div>
                    <span class="legend-label">制作過程の遅延</span>
                </div>
                <div class="legend-item">
                    <div class="legend-dot overdue"></div>
                    <span class="legend-label">期限切れ</span>
                </div>
            </div>

            <div class="process-grid">
                <!-- 原稿側 -->
                <div class="process-section">
                    <h3>📝 原稿側 <span style="font-size: 0.6em; color: #666; font-weight: normal;">(${manuscriptMagazines.length}件)</span></h3>
                    <div class="status-group">
                        <ul class="task-list">
${generateTaskItems(manuscriptMagazines, 'manuscript')}
                        </ul>
                    </div>
                </div>

                <!-- 動画側 -->
                <div class="process-section">
                    <h3>🎬 動画側 <span style="font-size: 0.6em; color: #666; font-weight: normal;">(${videoMagazines.length}件)</span></h3>
                    <div class="status-group">
                        <ul class="task-list">
${generateTaskItems(videoMagazines, 'video')}
                        </ul>
                    </div>
                </div>
            </div>
        </div>
  `;
}

/**
 * Generate calendar section
 */
function generateCalendarSection(healthData) {
  const { magazines } = healthData;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Calculate date range: 2 weeks before + this week + 2 weeks after (5 weeks total)
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 14 - today.getDay()); // Start from Sunday 2 weeks ago

  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 35); // 5 weeks = 35 days

  // Generate calendar days
  const calendarDays = [];
  const currentDate = new Date(startDate);

  while (currentDate < endDate) {
    calendarDays.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Map magazines to their due dates (use parent issue dueDate)
  const magazinesByDate = {};
  magazines.forEach(magazine => {
    if (magazine.dueDate) {
      const dueDate = new Date(magazine.dueDate);
      dueDate.setHours(0, 0, 0, 0);
      const dateKey = dueDate.toISOString().split('T')[0];

      if (!magazinesByDate[dateKey]) {
        magazinesByDate[dateKey] = [];
      }

      // Determine phase for coloring
      let phase = 'manuscript';
      if (magazine.label === '4.動画編集中') {
        phase = 'video';
      }

      // Check if already published
      // 1. Parent issue is completed
      // 2. All sub-issues are Done
      const parentCompleted = magazine.state?.type === 'completed';
      const allSubsDone = magazine.subIssues && magazine.subIssues.length > 0
        ? magazine.subIssues.every(s => s.state.name === 'Done' || s.state.type === 'completed')
        : false;

      if (parentCompleted || allSubsDone) {
        phase = 'published';
      }

      magazinesByDate[dateKey].push({
        title: convertTitleEmoji(magazine.title),
        phase,
        magazine
      });
    }
  });

  // Generate calendar grid HTML
  const calendarDaysHTML = calendarDays.map(date => {
    const dateKey = date.toISOString().split('T')[0];
    const isToday = date.getTime() === today.getTime();
    const tasksOnThisDay = magazinesByDate[dateKey] || [];

    const tasksHTML = tasksOnThisDay.map(task =>
      `<div class="calendar-task phase-${task.phase}">${task.title}</div>`
    ).join('');

    const todayLabel = isToday ? '<div style="font-weight: bold; color: #D60C52; font-size: 0.75em;">今日</div>' : '';

    return `
                <div class="calendar-day${isToday ? ' today' : ''}">
                    <div class="calendar-day-number">${formatDateShort(date)}</div>
                    ${todayLabel}
                    ${tasksHTML}
                </div>
    `;
  }).join('');

  return `
        <!-- 4. カレンダー -->
        <div class="calendar-section">
            <h2>📅 公開スケジュールカレンダー（前後2週間）</h2>

            <!-- カレンダー凡例 -->
            <div class="calendar-legend">
                <div class="calendar-legend-item">
                    <div class="calendar-legend-box manuscript"></div>
                    <span class="calendar-legend-label">原稿執筆中</span>
                </div>
                <div class="calendar-legend-item">
                    <div class="calendar-legend-box video"></div>
                    <span class="calendar-legend-label">動画制作中</span>
                </div>
                <div class="calendar-legend-item">
                    <div class="calendar-legend-box published"></div>
                    <span class="calendar-legend-label">公開済み</span>
                </div>
            </div>

            <div class="calendar-grid">
                <!-- 曜日ヘッダー -->
                <div class="calendar-header">日</div>
                <div class="calendar-header">月</div>
                <div class="calendar-header">火</div>
                <div class="calendar-header">水</div>
                <div class="calendar-header">木</div>
                <div class="calendar-header">金</div>
                <div class="calendar-header">土</div>

                ${calendarDaysHTML}
            </div>
        </div>
  `;
}

async function loadAISuggestions(healthData) {
  const aiDataPath = path.join(__dirname, '..', 'data', 'ai-suggestions.json');

  try {
    const content = await fs.readFile(aiDataPath, 'utf-8');
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length !== 3) {
      throw new Error('AI提案が3件揃っていません');
    }

    return parsed;
  } catch (error) {
    console.warn('⚠️  ai-suggestions.json の読み込みに失敗しました。フォールバック提案を使用します。', error.message);
    return {
      generatedAt: new Date().toISOString(),
      source: 'fallback',
      model: null,
      note: 'ai-suggestions.json が見つからないため、健康度データから再生成しました',
      suggestions: generateFallbackSuggestions(healthData)
    };
  }
}

/**
 * Generate complete HTML dashboard
 */
async function generateDashboard() {
  console.log('📊 ダッシュボードHTMLを生成中...');

  // Load health data
  const dataPath = path.join(__dirname, '..', 'data', 'health-data.json');
  let healthData;
  try {
    const dataContent = await fs.readFile(dataPath, 'utf-8');
    healthData = JSON.parse(dataContent);
  } catch (error) {
    console.error('❌ health-data.json の読み込みに失敗しました:', error.message);
    console.log('💡 先に npm run calculate-health を実行してください');
    process.exit(1);
  }

  const updateTime = new Date(healthData.calculatedAt).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Read styles from config file
  const stylesPath = path.join(__dirname, '..', 'config', 'dashboard-styles.css');
  let styles = await fs.readFile(stylesPath, 'utf-8');

  // Generate HTML sections
  const healthSection = generateHealthSection(healthData);
  const aiSuggestionsInfo = await loadAISuggestions(healthData);
  const aiSuggestionsSection = generateAISuggestionsSection(aiSuggestionsInfo);
  const magazineStatusSection = generateMagazineStatusSection(healthData);
  const calendarSection = generateCalendarSection(healthData);

  // Generate complete HTML
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>マガジン進捗管理ダッシュボード</title>
    <style>${styles}</style>
</head>
<body>
    <div class="container">
        <h1>📊 マガジン進捗管理ダッシュボード</h1>
        <div class="subtitle">${updateTime} 更新</div>

${healthSection}

${aiSuggestionsSection}

${magazineStatusSection}

${calendarSection}
    </div>
</body>
</html>
`;

  // Save to output/dashboard.html
  const outputDir = path.join(__dirname, '..', 'output');
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'dashboard.html');
  await fs.writeFile(outputPath, html);

  console.log('✅ ダッシュボードを生成しました: output/dashboard.html');
  console.log(`📊 データ更新日時: ${updateTime}`);

  return { outputPath, healthData };
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateDashboard().catch(error => {
    console.error('❌ エラーが発生しました:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
}

export default generateDashboard;

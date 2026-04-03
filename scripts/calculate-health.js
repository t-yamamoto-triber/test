#!/usr/bin/env node

/**
 * Calculate health indicators for magazine dashboard (4-category version)
 *
 * Categories:
 * 1. 企画案ストック (snapshot-based weekly cycle)
 * 2. 構成作成 (completedAt-based biweekly cycle)
 * 3. 原稿執筆 (deadline delay-based, realtime)
 * 4. 動画編集 (deadline delay-based, realtime)
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { LABEL_GROUPS, STATUS_LABELS, BIWEEKLY_EPOCH } from '../config/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Thresholds ---

async function loadThresholds() {
  const configPath = path.join(__dirname, '..', 'config', 'health-thresholds.yaml');
  const configContent = await fs.readFile(configPath, 'utf-8');
  return yaml.load(configContent);
}

// --- Shared helpers ---

function extractStatusLabels(subIssues, labelGroupName) {
  const labels = new Set();
  subIssues.forEach(sub => {
    sub.labels.forEach(label => {
      if (label.parent && label.parent.name === labelGroupName) {
        labels.add(label.name);
      }
    });
  });
  return Array.from(labels);
}

function getMaxProcessNumber(labelNames) {
  const numbers = labelNames
    .map(name => {
      const match = name.match(/^(\d+)\./);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter(n => n !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function sortLabelsByNumber(labelNames) {
  return labelNames.sort((a, b) => {
    const numA = parseInt(a.match(/^(\d+)\./)?.[1] || '999', 10);
    const numB = parseInt(b.match(/^(\d+)\./)?.[1] || '999', 10);
    return numA - numB;
  });
}

function findProcessInActiveIssues(subIssues, labelGroupName, processNumber) {
  const targetPrefix = `${processNumber}.`;
  const activeSubIssues = subIssues.filter(sub =>
    sub.state.type !== 'completed' &&
    sub.state.type !== 'started' &&
    sub.state.type !== 'canceled'
  );
  for (const sub of activeSubIssues) {
    for (const label of sub.labels) {
      if (label.parent && label.parent.name === labelGroupName && label.name.startsWith(targetPrefix)) {
        return label.name;
      }
    }
  }
  return null;
}

function determineCurrentProcesses(magazine) {
  const inProgressSubIssues = magazine.subIssues.filter(sub => sub.state.name === 'In Progress');
  const inProgressLabels = extractStatusLabels(inProgressSubIssues, LABEL_GROUPS.subIssueStatus);
  if (inProgressLabels.length > 0) return sortLabelsByNumber(inProgressLabels);

  const doneSubIssues = magazine.subIssues.filter(sub => sub.state.type === 'completed');
  const doneLabels = extractStatusLabels(doneSubIssues, LABEL_GROUPS.subIssueStatus);
  const maxProcessNumber = getMaxProcessNumber(doneLabels);
  if (maxProcessNumber === null) return [];

  const sameProcess = findProcessInActiveIssues(magazine.subIssues, LABEL_GROUPS.subIssueStatus, maxProcessNumber);
  if (sameProcess) return [sameProcess];

  const nextProcess = findProcessInActiveIssues(magazine.subIssues, LABEL_GROUPS.subIssueStatus, maxProcessNumber + 1);
  if (nextProcess) return [nextProcess];

  return [];
}

function calculateDelay(subIssue, today) {
  if (!subIssue.dueDate) {
    return { status: '🟡', label: '注意', days: null, tag: '期限未設定' };
  }
  const due = new Date(subIssue.dueDate);
  const diffMs = today - due;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return { status: '🟢', label: '順調', days: 0 };
  if (diffDays <= 1) return { status: '🟡', label: '注意', days: diffDays };
  return { status: '🔴', label: '危険', days: diffDays };
}

// --- Date helpers ---

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function getDayOfWeek(date) {
  return date.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
}

// --- Category 1: 企画案ストック (snapshot-based) ---

async function loadStockTracker() {
  const trackerPath = path.join(__dirname, '..', 'data', 'stock-tracker.json');
  try {
    const content = await fs.readFile(trackerPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveStockTracker(tracker) {
  const trackerPath = path.join(__dirname, '..', 'data', 'stock-tracker.json');
  await fs.mkdir(path.dirname(trackerPath), { recursive: true });
  await fs.writeFile(trackerPath, JSON.stringify(tracker, null, 2));
}

function calculateStockHealth(magazines, today) {
  const stockMagazines = magazines.filter(m => m.label === STATUS_LABELS.stock);
  const currentIds = stockMagazines.map(m => m.id);
  const stockCount = currentIds.length;

  return {
    currentIds,
    stockCount,
    stockMagazines,
  };
}

async function processStockSnapshot(magazines, today) {
  const { currentIds, stockCount } = calculateStockHealth(magazines, today);
  const mondayOfThisWeek = getMondayOfWeek(today);
  const weekStartStr = formatLocalDate(mondayOfThisWeek);
  const todayStr = formatLocalDate(today);

  let tracker = await loadStockTracker();

  if (!tracker || tracker.weekStart !== weekStartStr) {
    tracker = {
      weekStart: weekStartStr,
      snapshots: [{ date: todayStr, ids: currentIds }],
      weeklyNewIds: [],
    };
  } else {
    tracker.snapshots.push({ date: todayStr, ids: currentIds });
  }

  const firstSnapshot = tracker.snapshots[0];
  const firstIds = new Set(firstSnapshot.ids);
  const newIds = currentIds.filter(id => !firstIds.has(id));
  tracker.weeklyNewIds = newIds;

  await saveStockTracker(tracker);

  const weeklyNewCount = newIds.length;
  const dayOfWeek = getDayOfWeek(today);

  // Judgement table from design spec
  let status = '🟢';
  let label = '順調';
  let shortReason = '';

  if (dayOfWeek >= 5 || dayOfWeek === 0) {
    // Friday(5), Saturday(6), Sunday(0)
    if (weeklyNewCount >= 2) {
      status = '🟢'; label = '順調';
    } else {
      status = '🔴'; label = '危険';
      shortReason = '企画の新規追加が不足しています';
    }
  } else if (dayOfWeek >= 4) {
    // Thursday(4)
    if (weeklyNewCount >= 1) {
      status = '🟢'; label = '順調';
    } else {
      status = '🟡'; label = '注意';
      shortReason = '企画の新規追加が不足しています';
    }
  }
  // Mon-Wed: always green

  return {
    status,
    label,
    shortReason,
    weeklyNewCount,
    weeklyTarget: 2,
    stockCount,
    details: `今週の新規追加：${weeklyNewCount} / 2件`,
  };
}

// --- Category 2: 構成作成 (completedAt-based biweekly cycle) ---

function getBiweeklyStart(today) {
  // Epoch Monday: 2026-01-05 (a known Monday)
  const epoch = new Date(BIWEEKLY_EPOCH);
  const diffMs = today - epoch;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffWeeks = Math.floor(diffDays / 7);
  const cycleWeeks = Math.floor(diffWeeks / 2) * 2;
  const cycleStart = new Date(epoch);
  cycleStart.setDate(cycleStart.getDate() + cycleWeeks * 7);
  return cycleStart;
}

function calculateCompositionHealth(magazines, today) {
  const compositionMagazines = magazines.filter(m => m.label === STATUS_LABELS.composition);
  const cycleStart = getBiweeklyStart(today);
  const cycleEnd = new Date(cycleStart);
  cycleEnd.setDate(cycleEnd.getDate() + 14);

  let completedCount = 0;
  compositionMagazines.forEach(mag => {
    mag.subIssues.forEach(sub => {
      const hasCompositionLabel = sub.labels.some(l =>
        l.parent && l.parent.name === LABEL_GROUPS.subIssueStatus && l.name.startsWith('1.')
      );
      if (hasCompositionLabel && sub.completedAt) {
        const completed = new Date(sub.completedAt);
        if (completed >= cycleStart && completed < cycleEnd) {
          completedCount++;
        }
      }
    });
  });

  const daysSinceCycleStart = Math.floor((today - cycleStart) / (1000 * 60 * 60 * 24));
  const dayOfWeek = getDayOfWeek(today);
  const isWeek2 = daysSinceCycleStart >= 7;

  let status = '🟢';
  let label = '順調';
  let shortReason = '';
  let target = 3;

  if (isWeek2) {
    if (dayOfWeek >= 6) {
      // Week2 Sat
      target = 3;
      if (completedCount >= 3) { status = '🟢'; label = '順調'; }
      else { status = '🔴'; label = '危険'; shortReason = `構成が遅れています（完了 ${completedCount} / 目標 ${target}本）`; }
    } else if (dayOfWeek >= 4) {
      // Week2 Thu-Fri
      target = 3;
      if (completedCount >= 3) { status = '🟢'; label = '順調'; }
      else if (completedCount >= 2) { status = '🟡'; label = '注意'; shortReason = `構成が遅れています（完了 ${completedCount} / 目標 ${target}本）`; }
      else { status = '🔴'; label = '危険'; shortReason = `構成が遅れています（完了 ${completedCount} / 目標 ${target}本）`; }
    } else if (dayOfWeek >= 1) {
      // Week2 Mon-Wed
      target = 2;
      if (completedCount >= 2) { status = '🟢'; label = '順調'; }
      else if (completedCount >= 1) { status = '🟡'; label = '注意'; shortReason = `構成が遅れています（完了 ${completedCount} / 目標 ${target}本）`; }
      else { status = '🔴'; label = '危険'; shortReason = `構成が遅れています（完了 ${completedCount} / 目標 ${target}本）`; }
    } else {
      // Week2 Sun
      target = 3;
      if (completedCount >= 3) { status = '🟢'; label = '順調'; }
      else { status = '🔴'; label = '危険'; shortReason = `構成が遅れています（完了 ${completedCount} / 目標 ${target}本）`; }
    }
  } else {
    // Week 1
    if (dayOfWeek >= 5 || dayOfWeek === 0) {
      // Week1 Fri-Sun
      target = 1;
      if (completedCount >= 1) { status = '🟢'; label = '順調'; }
      else { status = '🟡'; label = '注意'; shortReason = `構成が遅れています（完了 ${completedCount} / 目標 ${target}本）`; }
    }
    // Week1 Mon-Thu: always green
  }

  const cycleStartStr = `${cycleStart.getFullYear()}/${cycleStart.getMonth() + 1}/${cycleStart.getDate()}`;
  const cycleEndDate = new Date(cycleEnd);
  cycleEndDate.setDate(cycleEndDate.getDate() - 1);
  const cycleEndStr = `${cycleEndDate.getMonth() + 1}/${cycleEndDate.getDate()}`;

  return {
    status,
    label,
    shortReason,
    completedCount,
    target,
    details: `完了：${completedCount} / ${target}本`,
    cyclePeriod: `${cycleStartStr} - ${cycleEndStr}`,
  };
}

// --- Category 3 & 4: 原稿執筆 / 動画編集 (existing logic) ---

function checkProcessDelays(subIssues, maxProcessNumber) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let maxDelayDays = 0;
  let delayedProcess = null;

  subIssues.forEach(sub => {
    if (sub.state?.type === 'completed' || sub.state?.type === 'canceled') return;
    sub.labels.forEach(label => {
      if (label.parent && label.parent.name === LABEL_GROUPS.subIssueStatus) {
        const match = label.name.match(/^(\d+)\./);
        if (match) {
          const processNumber = parseInt(match[1], 10);
          if (processNumber <= maxProcessNumber && sub.dueDate) {
            const due = new Date(sub.dueDate);
            due.setHours(0, 0, 0, 0);
            const delayDays = Math.floor((today - due) / (1000 * 60 * 60 * 24));
            if (delayDays > maxDelayDays) {
              maxDelayDays = delayDays;
              delayedProcess = label.name;
            }
          }
        }
      }
    });
  });

  let status = '🟢';
  if (maxDelayDays > 1) status = '🔴';
  else if (maxDelayDays > 0) status = '🟡';

  return { hasDelay: maxDelayDays > 0, delayDays: maxDelayDays, delayedProcess, status };
}

function checkNonDoneDelays(subIssues) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const delayedSubIssues = [];

  subIssues.forEach(sub => {
    if (sub.state?.type === 'completed' || sub.state?.type === 'canceled') return;
    if (sub.dueDate) {
      const due = new Date(sub.dueDate);
      due.setHours(0, 0, 0, 0);
      const delayDays = Math.floor((today - due) / (1000 * 60 * 60 * 24));
      if (delayDays > 0) {
        const processLabel = sub.labels.find(label =>
          label.parent && label.parent.name === LABEL_GROUPS.subIssueStatus
        );
        delayedSubIssues.push({
          title: sub.title,
          delayDays,
          processLabel: processLabel ? processLabel.name : sub.title
        });
      }
    }
  });
  return delayedSubIssues;
}

function determineDisplayHealthStatus(magazine, today) {
  const { label, subIssues, dueDate: publishDate } = magazine;
  let displayHealthStatus = { status: '🟢', message: '', isDeadlineNotSet: false };

  if (label === '3.原稿執筆中') {
    const processDelays = checkProcessDelays(subIssues, 2);
    const manuscriptSubs = subIssues.filter(sub =>
      sub.labels && sub.labels.some(l =>
        l.parent && l.parent.name === LABEL_GROUPS.subIssueStatus && l.name.includes('原稿')
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

    if (processDelays.status === '🔴') {
      displayHealthStatus = {
        status: '🔴',
        message: processDelays.delayedProcess ? `${processDelays.delayedProcess}が${processDelays.delayDays}日遅延` : '遅延あり',
        isDeadlineNotSet: false
      };
    } else if (processDelays.status === '🟡') {
      displayHealthStatus = {
        status: '🟡',
        message: processDelays.delayedProcess ? `${processDelays.delayedProcess}が${processDelays.delayDays}日遅延` : '遅延あり',
        isDeadlineNotSet: false
      };
    } else if (!manuscriptDueDate) {
      displayHealthStatus = { status: '🟡', message: '原稿期限未設定', isDeadlineNotSet: true };
    }
    if (!publishDate && displayHealthStatus.status === '🟢') {
      displayHealthStatus = { status: '🟡', message: '公開日未設定', isDeadlineNotSet: true };
    }

  } else if (label === '4.動画編集中') {
    const delayedSubs = checkNonDoneDelays(subIssues);
    if (delayedSubs.length > 0) {
      const maxDelayDays = Math.max(...delayedSubs.map(sub => sub.delayDays));
      const delayMessages = delayedSubs.map(sub => `${sub.processLabel}が${sub.delayDays}日遅延`);
      const status = maxDelayDays > 1 ? '🔴' : '🟡';
      displayHealthStatus = { status, message: delayMessages.join('、'), isDeadlineNotSet: false };
    }

    if (publishDate) {
      const todayZero = new Date(today); todayZero.setHours(0, 0, 0, 0);
      const publishDateObj = new Date(publishDate); publishDateObj.setHours(0, 0, 0, 0);
      const fourDaysBefore = new Date(publishDateObj);
      fourDaysBefore.setDate(fourDaysBefore.getDate() - 4);

      if (todayZero >= fourDaysBefore && todayZero < publishDateObj) {
        const thumbnailSub = subIssues.find(sub =>
          sub.labels && sub.labels.some(l =>
            l.parent && l.parent.name === LABEL_GROUPS.subIssueStatus && l.name.includes('サムネイル文言')
          )
        );
        if (thumbnailSub && thumbnailSub.state?.type !== 'completed' && thumbnailSub.state?.type !== 'canceled') {
          const daysUntilPublish = Math.floor((publishDateObj - todayZero) / (1000 * 60 * 60 * 24));
          const thumbnailMessage = `サムネイル文言が未完了（公開${daysUntilPublish}日前）`;
          if (displayHealthStatus.message) {
            displayHealthStatus = {
              status: displayHealthStatus.status === '🔴' ? '🔴' : '🟡',
              message: `${displayHealthStatus.message}、${thumbnailMessage}`,
              isDeadlineNotSet: false
            };
          } else {
            displayHealthStatus = { status: '🟡', message: thumbnailMessage, isDeadlineNotSet: false };
          }
        }
      }

      const todayZero2 = new Date(today); todayZero2.setHours(0, 0, 0, 0);
      const due = new Date(publishDate); due.setHours(0, 0, 0, 0);
      const publishDelayDays = Math.floor((todayZero2 - due) / (1000 * 60 * 60 * 24));
      if (publishDelayDays > 0) {
        displayHealthStatus = { status: '🔴', message: `公開日を${publishDelayDays}日超過`, isDeadlineNotSet: false };
      }
    } else {
      if (displayHealthStatus.status === '🟢') {
        displayHealthStatus = { status: '🟡', message: '公開日未設定', isDeadlineNotSet: true };
      }
    }
  }

  return displayHealthStatus;
}

// --- Aggregation with shortReason ---

function classifyReasonType(message) {
  if (!message) return null;
  if (message.includes('遅延')) return 'delay';
  if (message === '原稿期限未設定') return 'deadline-not-set';
  if (message === '公開日未設定') return 'publish-date-not-set';
  if (message.includes('超過')) return 'publish-date-exceeded';
  if (message.includes('サムネイル')) return 'thumbnail-incomplete';
  return 'other';
}

function buildReasonTemplates(typeCounts, categoryName) {
  const templates = [];
  if (typeCounts['delay'])
    templates.push(`${categoryName}が遅れています（${typeCounts['delay']}件）`);
  if (typeCounts['deadline-not-set'])
    templates.push(`原稿の期限が未設定です（${typeCounts['deadline-not-set']}件）`);
  if (typeCounts['publish-date-not-set'])
    templates.push(`公開日が未設定です（${typeCounts['publish-date-not-set']}件）`);
  if (typeCounts['publish-date-exceeded'])
    templates.push(`公開日を超過しています（${typeCounts['publish-date-exceeded']}件）`);
  if (typeCounts['thumbnail-incomplete'])
    templates.push(`サムネイル文言が未完了です（${typeCounts['thumbnail-incomplete']}件）`);
  if (typeCounts['other'])
    templates.push(`${categoryName}に注意が必要です（${typeCounts['other']}件）`);
  return templates;
}

function getWorstHealthStatus(magazines, categoryName) {
  if (magazines.length === 0) {
    return { status: '🟢', label: '順調', shortReason: '', details: 'タスクなし' };
  }

  let redCount = 0;
  let yellowCount = 0;
  const redTypeCounts = {};
  const yellowTypeCounts = {};

  magazines.forEach(m => {
    const msg = m.displayHealthStatus.message;
    if (m.displayHealthStatus.status === '🔴') {
      redCount++;
      const type = classifyReasonType(msg) || 'delay';
      redTypeCounts[type] = (redTypeCounts[type] || 0) + 1;
    } else if (m.displayHealthStatus.status === '🟡') {
      yellowCount++;
      const type = classifyReasonType(msg) || 'other';
      yellowTypeCounts[type] = (yellowTypeCounts[type] || 0) + 1;
    }
  });

  if (redCount > 0) {
    const allTypeCounts = { ...redTypeCounts };
    Object.entries(yellowTypeCounts).forEach(([type, count]) => {
      allTypeCounts[type] = (allTypeCounts[type] || 0) + count;
    });
    const templates = buildReasonTemplates(allTypeCounts, categoryName);
    return {
      status: '🔴',
      label: '危険',
      shortReason: templates.length > 0
        ? templates.join('\n')
        : `${categoryName}が遅れています（${redCount}件）`,
      details: `${redCount}件が遅延中 (合計${magazines.length}件)`
    };
  }
  if (yellowCount > 0) {
    const templates = buildReasonTemplates(yellowTypeCounts, categoryName);
    return {
      status: '🟡',
      label: '注意',
      shortReason: templates.length > 0
        ? templates.join('\n')
        : `${categoryName}に注意が必要です（${yellowCount}件）`,
      details: `${yellowCount}件が注意 (合計${magazines.length}件)`
    };
  }
  return {
    status: '🟢',
    label: '順調',
    shortReason: '',
    details: `全${magazines.length}件が順調`
  };
}

function getWorstOfAll(healthStatuses) {
  const hasRed = healthStatuses.some(h => h.status === '🔴');
  const hasYellow = healthStatuses.some(h => h.status === '🟡');

  const reasons = healthStatuses
    .filter(h => h.status !== '🟢' && h.shortReason)
    .map(h => h.shortReason);

  if (hasRed) {
    return {
      status: '🔴',
      label: '危険',
      details: reasons.length > 0 ? reasons.join('\n') : '遅延が発生しています'
    };
  }
  if (hasYellow) {
    return {
      status: '🟡',
      label: '注意',
      details: reasons.length > 0 ? reasons.join('\n') : '注意が必要です'
    };
  }
  return {
    status: '🟢',
    label: '順調',
    details: '全てのカテゴリで順調に進んでいます'
  };
}

// --- Main ---

async function calculateHealth() {
  console.log('🧮 健康度を計算中...');

  const dataPath = path.join(__dirname, '..', 'data', 'linear-data.json');
  let linearData;
  try {
    const dataContent = await fs.readFile(dataPath, 'utf-8');
    linearData = JSON.parse(dataContent);
  } catch (error) {
    console.error('❌ linear-data.json の読み込みに失敗しました:', error.message);
    console.log('💡 先に npm run fetch-data を実行してください');
    process.exit(1);
  }

  const thresholds = await loadThresholds();
  console.log('✅ 閾値設定を読み込みました');

  const today = new Date();

  const enrichedMagazines = linearData.magazines.map(magazine => {
    const currentProcesses = determineCurrentProcesses(magazine);
    const displayHealthStatus = determineDisplayHealthStatus(magazine, today);
    return {
      ...magazine,
      currentProcesses,
      displayHealthStatus,
      subIssuesEnriched: magazine.subIssues.map(sub => ({
        ...sub,
        delay: calculateDelay(sub, today)
      }))
    };
  });

  // Category 1: 企画案ストック
  const planStockHealth = await processStockSnapshot(enrichedMagazines, today);

  // Category 2: 構成作成
  const compositionHealth = calculateCompositionHealth(enrichedMagazines, today);

  // Category 3: 原稿執筆 (3.原稿執筆中)
  const manuscriptMagazines = enrichedMagazines.filter(m =>
    m.label === STATUS_LABELS.manuscript && m.state?.type !== 'completed'
  );
  const manuscriptHealth = getWorstHealthStatus(manuscriptMagazines, '原稿');

  // Category 4: 動画編集 (4.動画編集中)
  const videoMagazines = enrichedMagazines.filter(m =>
    m.label === STATUS_LABELS.video && m.state?.type !== 'completed'
  );
  const videoHealth = getWorstHealthStatus(videoMagazines, '動画');

  // Overall
  const overallHealth = getWorstOfAll([planStockHealth, compositionHealth, manuscriptHealth, videoHealth]);

  const result = {
    calculatedAt: new Date().toISOString(),
    magazines: enrichedMagazines,
    overallHealth,
    planStockHealth,
    compositionHealth,
    manuscriptHealth,
    videoHealth,
    summary: {
      total: enrichedMagazines.length,
      '1.企画案ストック': enrichedMagazines.filter(m => m.label === STATUS_LABELS.stock).length,
      '2.構成作成中': enrichedMagazines.filter(m => m.label === STATUS_LABELS.composition).length,
      '3.原稿執筆中': manuscriptMagazines.length,
      '4.動画編集中': videoMagazines.length
    },
    thresholds
  };

  const outputPath = path.join(__dirname, '..', 'data', 'health-data.json');
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2));

  console.log('💾 健康度データを data/health-data.json に保存しました');
  console.log('\n📊 健康度サマリー:');
  console.log(`  全体: ${overallHealth.status} ${overallHealth.label}`);
  console.log(`  企画案ストック: ${planStockHealth.status} ${planStockHealth.label} (新規${planStockHealth.weeklyNewCount}/2件, ストック${planStockHealth.stockCount}件)`);
  console.log(`  構成作成: ${compositionHealth.status} ${compositionHealth.label} (完了${compositionHealth.completedCount}/${compositionHealth.target}本)`);
  console.log(`  原稿執筆: ${manuscriptHealth.status} ${manuscriptHealth.label}`);
  console.log(`  動画編集: ${videoHealth.status} ${videoHealth.label}\n`);

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  calculateHealth().catch(error => {
    console.error('❌ エラーが発生しました:', error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  });
}

export default calculateHealth;

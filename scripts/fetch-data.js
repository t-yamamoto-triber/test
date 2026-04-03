#!/usr/bin/env node

/**
 * Fetch Linear data with sub-issues
 *
 * Fetches magazine parent issues and their sub-issues from Linear API.
 * Parent issues are filtered by status labels (1.企画案ストック, 2.構成作成中, 3.原稿執筆中, 4.動画編集中).
 * Sub-issues include status labels for process determination.
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { LINEAR_API_URL, LINEAR_TEAM_KEY, LABEL_GROUPS, STATUS_LABELS } from '../config/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LINEAR_API_KEY = process.env.MAGAZINE_LINEAR_API_KEY;

/**
 * Fetch magazines with sub-issues from Linear
 */
async function fetchLinearData() {
  console.log('📊 Linearからマガジンデータ+サブイシューを取得中...');

  if (!LINEAR_API_KEY) {
    console.error('❌ MAGAZINE_LINEAR_API_KEY が設定されていません');
    console.log('💡 環境変数 MAGAZINE_LINEAR_API_KEY=lin_api_xxxxx を設定してください');
    process.exit(1);
  }

  // Calculate date for 1 month ago
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  // GraphQL query to fetch active (in-progress) parent issues with sub-issues
  const activeQuery = `
    query GetActiveMagazines {
      issues(
        first: 200,
        filter: {
          team: {
            key: { eq: "${LINEAR_TEAM_KEY}" }
          },
          state: {
            type: { in: ["backlog", "unstarted", "started"] }
          },
          parent: {
            null: true
          }
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          state {
            id
            name
            type
          }
          labels {
            nodes {
              id
              name
              color
              parent {
                id
                name
              }
            }
          }
          assignee {
            id
            name
            displayName
          }
          dueDate
          createdAt
          updatedAt
          children {
            nodes {
              id
              identifier
              title
              url
              state {
                id
                name
                type
              }
              labels {
                nodes {
                  id
                  name
                  color
                  parent {
                    id
                    name
                  }
                }
              }
              dueDate
              completedAt
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  `;

  // GraphQL query to fetch completed parent issues (within last month)
  const completedQuery = `
    query GetCompletedMagazines {
      issues(
        first: 200,
        filter: {
          team: {
            key: { eq: "${LINEAR_TEAM_KEY}" }
          },
          state: {
            type: { eq: "completed" }
          },
          parent: {
            null: true
          },
          completedAt: {
            gte: "${oneMonthAgo.toISOString()}"
          }
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          state {
            id
            name
            type
          }
          labels {
            nodes {
              id
              name
              color
              parent {
                id
                name
              }
            }
          }
          assignee {
            id
            name
            displayName
          }
          dueDate
          createdAt
          updatedAt
          completedAt
          children {
            nodes {
              id
              identifier
              title
              url
              state {
                id
                name
                type
              }
              labels {
                nodes {
                  id
                  name
                  color
                  parent {
                    id
                    name
                  }
                }
              }
              dueDate
              completedAt
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  `;

  try {
    // Fetch active magazines
    const activeResponse = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': LINEAR_API_KEY
      },
      body: JSON.stringify({ query: activeQuery })
    });

    if (!activeResponse.ok) {
      throw new Error(`Linear API エラー: ${activeResponse.status} ${activeResponse.statusText}`);
    }

    const activeData = await activeResponse.json();

    if (activeData.errors) {
      console.error('GraphQL エラー:', activeData.errors);
      throw new Error('Linear APIからデータ取得に失敗しました');
    }

    const activeIssues = activeData.data.issues.nodes;
    console.log(`✅ ${activeIssues.length}件の未完了親イシューを取得しました`);

    // Fetch completed magazines
    const completedResponse = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': LINEAR_API_KEY
      },
      body: JSON.stringify({ query: completedQuery })
    });

    if (!completedResponse.ok) {
      throw new Error(`Linear API エラー: ${completedResponse.status} ${completedResponse.statusText}`);
    }

    const completedData = await completedResponse.json();

    if (completedData.errors) {
      console.error('GraphQL エラー:', completedData.errors);
      throw new Error('Linear APIからデータ取得に失敗しました');
    }

    const completedIssues = completedData.data.issues.nodes;
    console.log(`✅ ${completedIssues.length}件の1ヶ月以内に完了した親イシューを取得しました`);

    // Merge active and completed issues
    const allIssues = [...activeIssues, ...completedIssues];
    console.log(`✅ 合計 ${allIssues.length}件の親イシューを取得しました`);

    // Filter issues by magazine status label group
    const magazines = allIssues.filter(issue => {
      let hasStatusLabel = false;
      let hasStockStatus = false;

      for (const label of issue.labels.nodes) {
        if (label.parent && label.parent.name === LABEL_GROUPS.parentStatus) {
          hasStatusLabel = true;
          if (label.name === STATUS_LABELS.stock) {
            hasStockStatus = true;
            // ストックラベルが見つかった時点でこれ以上の走査は不要
            break;
          }
        }
      }

      if (!hasStatusLabel) {
        return false;
      }

      if (issue.state?.type === 'backlog') {
        // Backlog は「1.企画案ストック」ラベルが付いているもののみ残す
        return hasStockStatus;
      }

      return true;
    });

    console.log(`✅ ${magazines.length}件のマガジンイシューをフィルタしました`);

    // Count sub-issues
    const totalSubIssues = magazines.reduce((sum, mag) => sum + (mag.children?.nodes?.length || 0), 0);
    console.log(`✅ 合計 ${totalSubIssues}件のサブイシューを取得しました`);

    // Transform data structure
    const transformedMagazines = magazines.map(issue => {
      // Extract magazine status label (from the label group)
      const statusLabel = issue.labels.nodes.find(label =>
        label.parent && label.parent.name === LABEL_GROUPS.parentStatus
      );

      return {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        assignee: issue.assignee ? {
          id: issue.assignee.id,
          name: issue.assignee.displayName || issue.assignee.name
        } : null,
        dueDate: issue.dueDate,
        label: statusLabel?.name || null,
        state: {
          id: issue.state.id,
          name: issue.state.name,
          type: issue.state.type
        },
        subIssues: (issue.children?.nodes || []).map(sub => ({
          id: sub.id,
          identifier: sub.identifier,
          title: sub.title,
          url: sub.url,
          dueDate: sub.dueDate,
          completedAt: sub.completedAt || null,
          state: {
            id: sub.state.id,
            name: sub.state.name,
            type: sub.state.type
          },
          labels: sub.labels.nodes.map(label => ({
            id: label.id,
            name: label.name,
            color: label.color,
            parent: label.parent ? {
              id: label.parent.id,
              name: label.parent.name
            } : null
          })),
          createdAt: sub.createdAt,
          updatedAt: sub.updatedAt
        })),
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt
      };
    });

    // Prepare result
    const result = {
      fetchedAt: new Date().toISOString(),
      totalCount: transformedMagazines.length,
      magazines: transformedMagazines,
      summary: {
        '1.企画案ストック': transformedMagazines.filter(m => m.label === STATUS_LABELS.stock).length,
        '2.構成作成中': transformedMagazines.filter(m => m.label === STATUS_LABELS.composition).length,
        '3.原稿執筆中': transformedMagazines.filter(m => m.label === STATUS_LABELS.manuscript).length,
        '4.動画編集中': transformedMagazines.filter(m => m.label === STATUS_LABELS.video).length
      }
    };

    // Save to file
    const outputPath = path.join(__dirname, '..', 'data', 'linear-data.json');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2));

    console.log('💾 データを data/linear-data.json に保存しました');

    // Display summary
    console.log('\n📈 マガジンステータス別サマリー:');
    console.log(`  1.企画案ストック: ${result.summary['1.企画案ストック']}件`);
    console.log(`  2.構成作成中: ${result.summary['2.構成作成中']}件`);
    console.log(`  3.原稿執筆中: ${result.summary['3.原稿執筆中']}件`);
    console.log(`  4.動画編集中: ${result.summary['4.動画編集中']}件`);
    console.log(`  合計: ${result.totalCount}件\n`);

    return result;
  } catch (error) {
    console.error('❌ エラーが発生しました:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchLinearData();
}

export default fetchLinearData;

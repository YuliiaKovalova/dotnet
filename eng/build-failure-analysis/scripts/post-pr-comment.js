// Posts build failure analysis as a GitHub PR comment.
// Adapted for Azure DevOps → GitHub flow in dotnet/dotnet.
// Uses the GitHub REST API directly (no actions/github-script).

const fs = require('fs');

const ghToken = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || 'dotnet/dotnet';
const prNumber = process.env.PR_NUMBER;
const headSha = process.env.HEAD_SHA || '';
const buildUrl = process.env.BUILD_URL || '';
const analysisFile = process.env.ANALYSIS_FILE || '/tmp/analysis-result.md';

if (!ghToken) {
  console.error('GH_TOKEN is required');
  process.exit(1);
}

if (!prNumber) {
  console.error('PR_NUMBER is required');
  process.exit(1);
}

const [owner, repo] = repository.split('/');
const marker = '<!-- binlog-failure-analysis -->';
const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

async function ghApi(path, options = {}) {
  const url = path.startsWith('http') ? path : `${apiBase}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return null;
  return response.json();
}

async function main() {
  // Read analysis
  const fallback = `Build failed. Check the [Azure DevOps build](${buildUrl}) for details.`;
  let analysis;
  try {
    analysis = fs.readFileSync(analysisFile, 'utf8');
  } catch {
    analysis = fallback;
  }

  // Delete any existing analysis comments to avoid spam
  let page = 1;
  let deleted = 0;
  while (true) {
    const comments = await ghApi(`/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!comments || comments.length === 0) break;

    for (const c of comments) {
      if (c.body && c.body.includes(marker)) {
        await ghApi(`/issues/comments/${c.id}`, { method: 'DELETE' });
        deleted++;
      }
    }
    if (comments.length < 100) break;
    page++;
  }

  if (deleted > 0) {
    console.log(`Deleted ${deleted} previous analysis comment(s)`);
  }

  // Build the comment body
  const sha = headSha.substring(0, 7);
  const body = [
    marker,
    '## 🔍 Build Failure Analysis',
    '',
    analysis,
    '',
    '---',
    `<sub>🤖 Generated using <a href="https://dev.azure.com/dnceng/public/_artifacts/feed/dotnet-eng/NuGet/AITools.BinlogMcp">binlog-mcp</a>`,
    `· commit ${sha}`,
    buildUrl ? `· <a href="${buildUrl}">Azure DevOps build</a>` : '',
    `</sub>`,
  ].join('\n');

  // Post the comment
  await ghApi(`/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });

  console.log(`Posted analysis comment on PR #${prNumber}`);
}

main().catch(e => {
  console.error(`Failed to post PR comment: ${e.message}`);
  process.exitCode = 1;
});

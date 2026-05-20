// Posts LLM-generated inline fix suggestions as GitHub PR review comments.
// Adapted from microsoft/testfx PR #8326 for Azure DevOps → GitHub flow.
// Uses GitHub REST API directly instead of actions/github-script.

const fs = require('fs');
const path = require('path');

const ghToken = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || 'dotnet/dotnet';
const prNumber = process.env.PR_NUMBER;
const headSha = process.env.HEAD_SHA;
const workspace = process.env.GITHUB_WORKSPACE_PATH;

if (!ghToken || !prNumber || !headSha) {
  console.error('GH_TOKEN, PR_NUMBER, and HEAD_SHA are required');
  process.exit(1);
}

const [owner, repo] = repository.split('/');
const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

async function ghApi(urlPath, options = {}) {
  const url = urlPath.startsWith('http') ? urlPath : `${apiBase}${urlPath}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function ghPaginate(urlPath) {
  const results = [];
  let page = 1;
  while (true) {
    const items = await ghApi(`${urlPath}${urlPath.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!items || items.length === 0) break;
    results.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return results;
}

function toRelPath(absPath) {
  const patterns = [
    workspace + '/', workspace + '\\',
    /^\/agent\/_work\/\d+\/s\//,
    /^\/home\/vsts\/work\/\d+\/s\//,
    /^\/home\/runner\/work\/[^/]+\/[^/]+\//,
    /^D:\\a\\[^\\]+\\[^\\]+\\/,
  ];
  let rel = absPath;
  for (const p of patterns) {
    if (typeof p === 'string' && rel.startsWith(p)) { rel = rel.substring(p.length); break; }
    else if (p instanceof RegExp) { rel = rel.replace(p, ''); }
  }
  return rel.replace(/\\/g, '/');
}

async function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(process.env.BINLOG_DATA, 'utf8'));
  } catch { return; }

  let parsedErrors = [];
  try { parsedErrors = JSON.parse(data.errors || '[]'); } catch {}
  if (parsedErrors.length === 0) {
    console.log('No parsed errors, skipping suggestions');
    return;
  }

  // Get PR diff files
  const prFiles = await ghPaginate(`/pulls/${prNumber}/files`);
  const prFilePaths = new Set(prFiles.map(f => f.filename));

  // Build set of lines in the PR diff
  const diffLines = new Set();
  for (const f of prFiles) {
    if (!f.patch) continue;
    const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match;
    while ((match = hunkRegex.exec(f.patch)) !== null) {
      const start = parseInt(match[1]);
      const count = parseInt(match[2] || '1');
      for (let i = start; i < start + count; i++) {
        diffLines.add(`${f.filename}:${i}`);
      }
    }
  }

  // Collect suggestion candidates
  const candidates = [];

  console.log(`Checking ${parsedErrors.length} errors against ${prFilePaths.size} PR files and ${diffLines.size} diff lines`);

  for (const err of parsedErrors) {
    if (!err.file || !err.line || !err.code) continue;
    const relPath = toRelPath(err.file);
    const inPr = prFilePaths.has(relPath);
    const inDiff = diffLines.has(`${relPath}:${err.line}`);
    console.log(`  ${err.code} at ${relPath}:${err.line} — inPR=${inPr}, inDiff=${inDiff}`);
    if (!inPr || !inDiff) continue;
    let contextLines = '';
    try {
      let filePath = err.file;
      if (!fs.existsSync(filePath)) filePath = path.join(workspace, relPath);
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        const start = Math.max(0, err.line - 4);
        const end = Math.min(lines.length, err.line + 4);
        contextLines = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      }
    } catch {}
    if (contextLines) candidates.push({ err, relPath, contextLines });
  }

  // For errors on non-PR files, find the declaration in PR files
  const nonPrErrors = [...new Map(
    parsedErrors.filter(e => e.file && e.line && e.code && !prFilePaths.has(toRelPath(e.file)))
      .map(e => [e.message, e])
  ).values()];

  for (const err of nonPrErrors.slice(0, 3)) {
    const nameMatch = err.message.match(/'([^']+)'/);
    if (!nameMatch) continue;
    for (const prFile of prFiles) {
      if (!prFile.filename.endsWith('.cs') && !prFile.filename.endsWith('.props') && !prFile.filename.endsWith('.targets')) continue;
      try {
        const fullPath = path.join(workspace, prFile.filename);
        if (!fs.existsSync(fullPath)) continue;
        const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(nameMatch[1]) || !diffLines.has(`${prFile.filename}:${i + 1}`)) continue;
          const start = Math.max(0, i - 3);
          const end = Math.min(lines.length, i + 4);
          const contextLines = lines.slice(start, end).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
          candidates.push({
            err: { ...err, file: fullPath, line: i + 1 },
            relPath: prFile.filename,
            contextLines,
            isDeclaration: true,
          });
          break;
        }
      } catch {}
      if (candidates.length >= 10) break;
    }
  }

  if (candidates.length === 0) {
    console.log('No suggestion candidates found in PR diff');
    return;
  }

  // Ask LLM for exact replacement lines
  const fixPrompt = [
    'You are a C# / MSBuild code fix assistant for the dotnet/dotnet VMR.',
    'For each build error below, produce the EXACT fixed line(s) to replace the erroring line.',
    'Reply ONLY with a JSON array. Each element: {"index": N, "fixed_lines": "replacement code", "explanation": "one sentence"}',
    'Rules: preserve indentation, set fixed_lines to "" to delete a line, omit index if no fix, no markdown fences.',
    '',
  ];
  candidates.slice(0, 10).forEach((c, idx) => {
    fixPrompt.push(`--- Error ${idx} ---`);
    fixPrompt.push(`File: ${c.relPath}, Line: ${c.err.line}`);
    fixPrompt.push(`Error: ${c.err.code}: ${c.err.message}`);
    if (c.isDeclaration) fixPrompt.push('(Declaration that caused caller errors — make backward-compatible)');
    fixPrompt.push('Context:', c.contextLines, '');
  });

  let fixes = [];
  const endpoints = [
    'https://models.github.ai/inference/chat/completions',
    'https://models.inference.ai.azure.com/chat/completions',
  ];
  for (const endpoint of endpoints) {
    if (fixes.length > 0) break;
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: fixPrompt.join('\n') }],
          max_tokens: 2000,
        }),
      });
      if (resp.ok) {
        const result = await resp.json();
        let content = result.choices?.[0]?.message?.content || '';
        content = content.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
        fixes = JSON.parse(content);
        console.log(`LLM returned ${fixes.length} fix suggestion(s)`);
      } else {
        console.log(`${endpoint}: ${resp.status}`);
      }
    } catch (e) {
      console.log(`Fix suggestion LLM failed: ${e.message}`);
    }
  }

  // Post suggestions via GitHub API
  let posted = 0;
  console.log(`Processing ${fixes.length} fixes against ${candidates.length} candidates`);
  for (const fix of fixes) {
    console.log(`  Fix: index=${fix.index}, fixed_lines=${JSON.stringify(fix.fixed_lines)?.substring(0, 80)}`);
    if (fix.index == null || fix.index >= candidates.length) {
      console.log(`  Skipped: index out of range (candidates=${candidates.length})`);
      continue;
    }
    const c = candidates[fix.index];
    const body = `🔧 **\`${c.err.code}\`**: ${fix.explanation || ''}\n\`\`\`suggestion\n${fix.fixed_lines ?? ''}\n\`\`\``;
    try {
      const payload = {
        commit_id: headSha,
        path: c.relPath,
        subject_type: 'line',
        line: c.err.line,
        side: 'RIGHT',
        body,
      };
      console.log(`  Posting to ${c.relPath}:${c.err.line} commit=${headSha.substring(0, 7)}`);
      await ghApi(`/pulls/${prNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      posted++;
      console.log(`  ✅ Posted suggestion on ${c.relPath}:${c.err.line}`);
    } catch (e) {
      console.error(`  ❌ Could not post on ${c.relPath}:${c.err.line}: ${e.message}`);
    }
    if (posted >= 10) break;
  }
  console.log(`Posted ${posted} inline suggestion(s)`);
}

main().catch(e => {
  console.error(`Failed: ${e.message}`);
  process.exitCode = 1;
});

// Tests for shared utility functions used across analysis scripts.
// Run with: node test-utils.js

const assert = require('assert');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}: ${e.message}`);
  }
}

// ── toRelPath tests ──────────────────────────────────────────────────

function toRelPath(absPath, workspace) {
  if (!absPath) return absPath;
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

console.log('\ntoRelPath:');

test('strips AzDO agent path /agent/_work/1/s/', () => {
  assert.strictEqual(
    toRelPath('/agent/_work/1/s/src/MyProject/File.cs', '/workspace'),
    'src/MyProject/File.cs'
  );
});

test('strips AzDO hosted agent path /home/vsts/work/1/s/', () => {
  assert.strictEqual(
    toRelPath('/home/vsts/work/1/s/eng/Version.Details.xml', '/workspace'),
    'eng/Version.Details.xml'
  );
});

test('strips GitHub runner path', () => {
  assert.strictEqual(
    toRelPath('/home/runner/work/dotnet/dotnet/src/File.cs', '/workspace'),
    'src/File.cs'
  );
});

test('strips Windows runner path', () => {
  assert.strictEqual(
    toRelPath('D:\\a\\dotnet\\dotnet\\src\\File.cs', '/workspace'),
    'src/File.cs'
  );
});

test('strips workspace prefix (unix)', () => {
  assert.strictEqual(
    toRelPath('/home/vsts/work/1/s/src/File.cs', '/home/vsts/work/1/s'),
    'src/File.cs'
  );
});

test('strips workspace prefix (windows backslash)', () => {
  assert.strictEqual(
    toRelPath('C:\\build\\src\\File.cs', 'C:\\build'),
    'src/File.cs'
  );
});

test('preserves relative path unchanged', () => {
  assert.strictEqual(
    toRelPath('src/MyProject/File.cs', '/workspace'),
    'src/MyProject/File.cs'
  );
});

test('handles null/undefined', () => {
  assert.strictEqual(toRelPath(null, '/workspace'), null);
  assert.strictEqual(toRelPath(undefined, '/workspace'), undefined);
});

test('handles multi-digit work directory numbers', () => {
  assert.strictEqual(
    toRelPath('/agent/_work/42/s/src/File.cs', '/workspace'),
    'src/File.cs'
  );
});

// ── merge-errors deduplication tests ─────────────────────────────────

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

console.log('\nmerge-errors.js:');

function testMerge(name, combined, newBinlog, expected) {
  test(name, () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-test-'));
    const combinedPath = path.join(tmpDir, 'combined.json');
    const newPath = path.join(tmpDir, 'new.json');
    const outPath = path.join(tmpDir, 'out.json');

    fs.writeFileSync(combinedPath, JSON.stringify(combined));
    fs.writeFileSync(newPath, JSON.stringify(newBinlog));

    execSync(`node "${path.join(__dirname, 'merge-errors.js')}" "${combinedPath}" "${newPath}" "${outPath}"`, { stdio: 'pipe' });

    const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.strictEqual(result.length, expected.length, `Expected ${expected.length} errors, got ${result.length}`);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true });
  });
}

testMerge(
  'merges two non-overlapping sets',
  [{ code: 'CS0001', message: 'err1', file: 'a.cs', line: 1 }],
  { errors: JSON.stringify([{ code: 'CS0002', message: 'err2', file: 'b.cs', line: 2 }]) },
  [1, 2] // 2 unique errors
);

testMerge(
  'deduplicates identical errors',
  [{ code: 'CS0001', message: 'err1', file: 'a.cs', line: 1 }],
  { errors: JSON.stringify([{ code: 'CS0001', message: 'err1', file: 'a.cs', line: 1 }]) },
  [1] // 1 unique error after dedup
);

testMerge(
  'handles empty combined set',
  [],
  { errors: JSON.stringify([{ code: 'CS0001', message: 'err1', file: 'a.cs', line: 1 }]) },
  [1]
);

testMerge(
  'handles empty new set',
  [{ code: 'CS0001', message: 'err1', file: 'a.cs', line: 1 }],
  { errors: '[]' },
  [1]
);

testMerge(
  'handles plain string errors field',
  [],
  { errors: 'Some build error text' },
  [1]
);

// ── linkifyFileReferences tests ──────────────────────────────────────

console.log('\nlinkifyFileReferences:');

function fileLink(absPath, line, workspace, headSha) {
  const rel = toRelPath(absPath, workspace);
  const url = `https://github.com/dotnet/dotnet/blob/${headSha}/${rel}`;
  return line ? `${url}#L${line}` : url;
}

function linkifyFileReferences(text, parsedErrors, workspace, headSha) {
  const fileLinks = {};
  for (const err of parsedErrors) {
    if (!err.file) continue;
    const basename = err.file.split(/[/\\]/).pop();
    if (!fileLinks[basename]) {
      fileLinks[basename] = { urlNoLine: fileLink(err.file, null, workspace, headSha), fullPath: err.file };
    }
  }
  for (const [basename, info] of Object.entries(fileLinks)) {
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(
      new RegExp('(?<!\\[)`(' + escaped + ')`(?!\\])', 'g'),
      `[\`${basename}\`](${info.urlNoLine})`
    );
    text = text.replace(
      new RegExp('line (\\d+) of `?' + escaped + '`?', 'g'),
      (_, lineNum) => `[line ${lineNum} of \`${basename}\`](${fileLink(info.fullPath, parseInt(lineNum), workspace, headSha)})`
    );
  }
  return text;
}

test('linkifies backtick-wrapped filenames', () => {
  const errors = [{ file: '/agent/_work/1/s/src/File.cs', line: 10 }];
  const result = linkifyFileReferences('See `File.cs` for details', errors, '/workspace', 'abc123');
  assert.ok(result.includes('[`File.cs`]'), `Expected link, got: ${result}`);
  assert.ok(result.includes('github.com/dotnet/dotnet/blob/abc123/src/File.cs'), result);
});

test('linkifies "line N of File.cs"', () => {
  const errors = [{ file: '/agent/_work/1/s/src/File.cs', line: 10 }];
  const result = linkifyFileReferences('See line 42 of File.cs', errors, '/workspace', 'abc123');
  assert.ok(result.includes('#L42'), `Expected line link, got: ${result}`);
});

test('does not double-linkify already linked files', () => {
  const errors = [{ file: '/agent/_work/1/s/src/File.cs', line: 10 }];
  const input = 'See [`File.cs`](http://example.com) for details';
  const result = linkifyFileReferences(input, errors, '/workspace', 'abc123');
  assert.strictEqual(result, input, 'Should not modify already-linked text');
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

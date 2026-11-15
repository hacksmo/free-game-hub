/* github.com:443 不通但 api.github.com 可达时的推送兜底：
 * 用 Git Data API 按本地提交的精确元数据重建提交（blob→tree→commit），
 * SHA 与本地完全一致后才更新远端引用。不打印任何凭据。
 * 用法: node tools/push-via-api.mjs <localCommitSha> <branch>
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const LOCAL = process.argv[2];
const BRANCH = process.argv[3] || 'main';
// 可选第 4 个参数指定 owner/repo（默认 CARCADE 本仓库），用于推送另一个独立仓库。
const REPO = process.argv[4] || 'hacksmo/free-game-hub';
if (!LOCAL) { console.error('usage: node tools/push-via-api.mjs <localCommitSha> [branch] [owner/repo]'); process.exit(1); }
// 归一成完整 SHA：短 SHA 与 API 返回的长 SHA 直接比较必然不等，会误报「SHA 不一致」。
const LOCAL_FULL = execSync(`git rev-parse ${LOCAL}`, { encoding: 'utf8' }).trim();

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const api = async (method, path, body) => {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'carcade-api-push',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
};

// 本地提交的精确元数据
const raw = execSync(`git cat-file commit ${LOCAL_FULL}`, { encoding: 'utf8' });
const idx = raw.indexOf('\n\n');
const head = raw.slice(0, idx);
const message = raw.slice(idx + 2); // 含末尾换行，原样保留
const hl = head.split('\n');
const tree = hl.find((l) => l.startsWith('tree ')).slice(5);
const parent = hl.find((l) => l.startsWith('parent ')).slice(7);
const parseIdent = (s) => {
  const m = s.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!m) throw new Error('bad ident: ' + s);
  const [, name, email, ts, tz] = m;
  const sign = tz[0] === '-' ? -1 : 1;
  const offMs = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5))) * 60000;
  const d = new Date(Number(ts) * 1000 + offMs);
  const p = (n) => String(n).padStart(2, '0');
  // GitHub 侧一律以 UTC（+0000）存储时间：带偏移的 ISO 串会被它换算掉，
  // 于是提交对象与本地不同 → SHA 对不上。所以零偏移时直接输出 Z 形式。
  const isUtc = tz === '+0000' || tz === '-0000';
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    + (isUtc ? 'Z' : `${tz.slice(0, 3)}:${tz.slice(3)}`);
  return { name, email, date };
};
const author = parseIdent(hl.find((l) => l.startsWith('author ')).slice(7));
const committer = parseIdent(hl.find((l) => l.startsWith('committer ')).slice(10));

// 远端必须正好停在本地提交的父提交上
const ref = await api('GET', `/repos/${REPO}/git/refs/heads/${BRANCH}`);
console.log('remote', BRANCH, '=', ref.object.sha);
if (ref.object.sha !== parent) { console.error('ABORT: 远端已移动，不等于本地提交的 parent'); process.exit(2); }

// 从父树重建：新增/修改的路径放新 blob，删除的路径放 sha:null。
// 注意用 --no-renames：重命名会显示成 D+A 两行，才能把旧路径从树上删掉；
// 否则父树里会残留旧目录，导致 tree SHA 对不上。
const parentCommit = await api('GET', `/repos/${REPO}/git/commits/${parent}`);
const status = execSync(`git diff --name-status --no-renames ${parent} ${LOCAL_FULL}`, { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
console.log('changed files:', status.map((l) => l.split('\t').join(' ')).join(', '));
const entries = [];
// 文件模式必须取**本地真实模式**（100755 / 100644），不能硬编码 100644：
// 可执行文件（如 deploy/deploy-games.sh）若被写成 100644，tree SHA 与本地不一致，
// 脚本会在「tree 不一致」处中止，推送做不完。
const localMode = (p) => execSync(`git ls-files -s -- ${JSON.stringify(p)}`, { encoding: 'utf8' })
  .trim().split(/\s+/)[0] || '100644';
for (const line of status) {
  const [code, ...rest] = line.split('\t');
  const f = rest[rest.length - 1];
  if (code === 'D') {
    // 删除：sha 置 null，GitHub 会把该路径从树上摘掉
    entries.push({ path: f, mode: '100644', type: 'blob', sha: null });
    console.log(`del ${f}`);
    continue;
  }
  const blob = await api('POST', `/repos/${REPO}/git/blobs`, { content: fs.readFileSync(f).toString('base64'), encoding: 'base64' });
  const localBlob = execSync(`git rev-parse ${LOCAL_FULL}:${f}`, { encoding: 'utf8' }).trim();
  console.log(`blob ${f}: api=${blob.sha} local=${localBlob} match=${blob.sha === localBlob}`);
  if (blob.sha !== localBlob) { console.error('ABORT: blob 不一致'); process.exit(3); }
  entries.push({ path: f, mode: localMode(f), type: 'blob', sha: blob.sha });
}
const newTree = await api('POST', `/repos/${REPO}/git/trees`, { base_tree: parentCommit.tree.sha, tree: entries });
console.log(`tree: api=${newTree.sha} local=${tree} match=${newTree.sha === tree}`);
if (newTree.sha !== tree) { console.error('ABORT: tree 不一致'); process.exit(4); }

const commit = await api('POST', `/repos/${REPO}/git/commits`, { message, tree: newTree.sha, parents: [parent], author, committer });
console.log(`commit: api=${commit.sha} local=${LOCAL_FULL} match=${commit.sha === LOCAL_FULL}`);
if (commit.sha !== LOCAL_FULL) { console.error('ABORT: commit SHA 不一致，不更新远端引用'); process.exit(5); }

if (process.env.DRY_RUN === '1') { console.log('DRY_RUN: 对象重建成功且 SHA 一致，未更新远端引用'); process.exit(0); }

await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
const verify = await api('GET', `/repos/${REPO}/git/refs/heads/${BRANCH}`);
console.log('VERIFIED remote', BRANCH, '=', verify.object.sha);
if (verify.object.sha !== LOCAL_FULL) process.exit(6);
console.log('PUSH OK（API 通道，SHA 与本地一致）');

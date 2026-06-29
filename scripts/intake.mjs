/**
 * Issue 投稿机器人（GitHub Actions 内运行）
 *
 * 从正文取脚本来源（附件 或 raw 直链）→ 拉取 → 静态校验 + 查重 → 通过则建分支，
 * 同时写入 plugins/<id>.js 与重建 registry.json，开 PR 交维护者审查（标 待审核）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parseHeader, validateSource, isNewerVersion } from "./header.mjs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf-8"));
const issue = event.issue;

if (!issue) process.exit(0);

const at = issue.user?.login ? `@${issue.user.login} ` : "";

async function gh(method, path, payload) {
  return fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}
const comment = (body) => gh("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body });
const addIssueLabel = (n) => gh("POST", `/repos/${repo}/issues/${issue.number}/labels`, { labels: [n] });
const removeIssueLabel = (n) =>
  gh("DELETE", `/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(n)}`);

/** 置 issue 校验状态标签 */
async function setStatus(passed) {
  await addIssueLabel(passed ? "校验通过" : "校验未通过");
  await removeIssueLabel(passed ? "校验未通过" : "校验通过");
}

const urls = [...(issue.body ?? "").matchAll(/https?:\/\/[^\s)<>"']+/g)].map((m) => m[0]);
const source_url = urls.find((u) =>
  /github\.com\/user-attachments\/|\/files\/\d+\/|\.js(\?|$)/i.test(u),
);

if (!source_url) {
  await setStatus(false);
  await comment(`${at}⚠️ 未找到脚本。请把 \`.js\` 拖进文本框上传，或粘贴脚本 raw 直链，然后编辑本 issue 重新校验。`);
  process.exit(0);
}

const is_github = /^https:\/\/([^/]+\.)?(github\.com|githubusercontent\.com)\//i.test(source_url);
let source;
try {
  const res = await fetch(source_url, is_github ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  source = await res.text();
} catch (err) {
  await setStatus(false);
  await comment(`${at}❌ 拉取脚本失败：${err.message}`);
  process.exit(0);
}

const { id, header, errors } = validateSource(source);
if (errors.length) {
  await setStatus(false);
  await comment(`${at}❌ 校验未通过：\n` + errors.map((e) => `- ${e}`).join("\n") + "\n\n修正后编辑本 issue 重新校验。");
  process.exit(0);
}

// 查重
const file = `plugins/${id}.js`;
const is_update = existsSync(file);
const old_version = is_update ? (parseHeader(readFileSync(file, "utf-8")).version ?? "0.0.0") : null;
const version = header.version ?? "0.0.0";

// 更新必须是严格递增的版本，杜绝同版本/降级盲覆盖（历史版本仍留在 git 提交记录里）
if (is_update && !isNewerVersion(version, old_version)) {
  await setStatus(false);
  await comment(
    `${at}❌ 更新被拒：新版本 v${version} 必须高于现版本 v${old_version}。请提高 @version 后编辑本 issue 重新校验。`,
  );
  process.exit(0);
}

// 仅把插件写进 PR；registry.json 由合并后的 build-registry 从 main 重建（避免并发丢条目）
writeFileSync(file, source);

const branch = `submit/${id}`;
execSync('git config user.name "github-actions[bot]"');
execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
execSync(`git checkout -B ${branch}`);
execSync(`git add ${file}`);
let changed = true;
try {
  execSync("git diff --cached --quiet HEAD");
  changed = false;
} catch {
  changed = true;
}
if (changed) {
  const type = is_update ? "chore" : "feat";
  const verb = is_update ? "update" : "add";
  execSync(`git commit -m "${type}(plugin): ${verb} ${id} v${version}"`);
  execSync(`git push -f origin ${branch}`);
}

// 开 PR（已存在则复用），并标记 待审核
const owner = repo.split("/")[0];
const open = await (await gh("GET", `/repos/${repo}/pulls?head=${owner}:${branch}&state=open`)).json();
let pr;
if (Array.isArray(open) && open.length) {
  pr = open[0];
} else {
  pr = await (
    await gh("POST", `/repos/${repo}/pulls`, {
      title: `${is_update ? "update" : "add"} ${id} v${version}`,
      head: branch,
      base: "main",
      body: `Closes #${issue.number}`,
    })
  ).json();
}

if (pr?.number) {
  await gh("POST", `/repos/${repo}/issues/${pr.number}/labels`, { labels: ["待审核"] });
}
await setStatus(true);

const note = is_update ? `更新 v${old_version} → v${version}` : "新插件";
await comment(`${at}✅ 校验通过，${note}，已提交 PR 待维护者审查：${pr?.html_url ?? "PR 创建失败"}`);
console.log("done", id, pr?.html_url);

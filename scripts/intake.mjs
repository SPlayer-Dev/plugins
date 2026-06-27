/**
 * Issue 投稿机器人（GitHub Actions 内运行）
 *
 * 从正文取脚本来源（附件 或 raw 直链）→ 拉取 → 静态校验 + 查重 → 校验通过则建分支提交并开 PR
 * 交维护者在 PR 审查；不通过则回贴原因。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parseHeader, validateSource } from "./header.mjs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf-8"));
const issue = event.issue;

if (!issue) process.exit(0);

async function gh(method, path, payload) {
  return fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}
const comment = (body) => gh("POST", `/repos/${repo}/issues/${issue.number}/comments`, { body });
const addLabel = (name) => gh("POST", `/repos/${repo}/issues/${issue.number}/labels`, { labels: [name] });
const removeLabel = (name) =>
  gh("DELETE", `/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(name)}`);

/** 置校验状态标签 */
async function setStatus(passed) {
  await addLabel(passed ? "校验通过" : "校验未通过");
  await removeLabel(passed ? "校验未通过" : "校验通过");
}

const urls = [...(issue.body ?? "").matchAll(/https?:\/\/[^\s)<>"']+/g)].map((m) => m[0]);
const source_url = urls.find((u) =>
  /github\.com\/user-attachments\/|\/files\/\d+\/|\.js(\?|$)/i.test(u),
);

if (!source_url) {
  await comment("⚠️ 未找到脚本。请把 `.js` 拖进文本框上传，或粘贴脚本 raw 直链，然后编辑本 issue 重新校验。");
  process.exit(0);
}

// 仅对 GitHub 自家域名带 token；外部直链不带，防泄露
const is_github = /^https:\/\/([^/]+\.)?(github\.com|githubusercontent\.com)\//i.test(source_url);
let source;
try {
  const res = await fetch(source_url, is_github ? { headers: { Authorization: `Bearer ${token}` } } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  source = await res.text();
} catch (err) {
  await comment(`❌ 拉取脚本失败：${err.message}`);
  process.exit(0);
}

const { id, header, errors } = validateSource(source);
if (errors.length) {
  await setStatus(false);
  await comment("❌ 校验未通过：\n" + errors.map((e) => `- ${e}`).join("\n") + "\n\n修正后编辑本 issue 重新校验。");
  process.exit(0);
}

// 查重：同 @id 已存在则视为更新
const file = `plugins/${id}.js`;
const is_update = existsSync(file);
const old_version = is_update ? (parseHeader(readFileSync(file, "utf-8")).version ?? "?") : null;
const version = header.version ?? "0.0.0";

// 建分支、写文件、提交、推送
const branch = `submit/${id}`;
writeFileSync(file, source);
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

// 开 PR（已存在则复用）
const owner = repo.split("/")[0];
const open = await (await gh("GET", `/repos/${repo}/pulls?head=${owner}:${branch}&state=open`)).json();
let pr_url;
if (Array.isArray(open) && open.length) {
  pr_url = open[0].html_url;
} else {
  const pr = await (
    await gh("POST", `/repos/${repo}/pulls`, {
      title: `${is_update ? "update" : "add"} ${id} v${version}`,
      head: branch,
      base: "main",
      body: `Closes #${issue.number}`,
    })
  ).json();
  pr_url = pr.html_url ?? "PR 创建失败";
}

const note = is_update ? `更新 v${old_version} → v${version}` : "新插件";
await setStatus(true);
await comment(`✅ 校验通过，${note}，已提交 PR 待维护者审查：${pr_url}`);
console.log("done", id, pr_url);

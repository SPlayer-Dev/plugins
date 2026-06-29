/**
 * 维护者在 PR 提交 review 后：同步 PR 状态标签，并把结果回贴到关联 issue 通知投稿人
 *
 * approved → 已通过；changes_requested → 已拒绝。PR 由机器人创建（作者不是投稿人），
 * 故审核结果必须经 PR 正文的 Closes #N 回到原 issue，否则投稿人在 issue 上看不到驳回意见。
 */

import { readFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf-8"));
const pr = event.pull_request;
const review = event.review;
const number = pr.number;
const state = review.state;

const gh = (method, path, payload) =>
  fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
const add = (n) => gh("POST", `/repos/${repo}/issues/${number}/labels`, { labels: [n] });
const remove = (n) => gh("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(n)}`);

/** 从 PR 正文的 Closes #N 取关联 issue 号 */
const linkedIssue = () => {
  const matched = (pr.body ?? "").match(/#(\d+)/);
  return matched ? Number(matched[1]) : null;
};

/** 回贴到关联 issue，并 @ 投稿人 */
async function notifyIssue(body) {
  const issueNo = linkedIssue();
  if (!issueNo) return;
  const res = await gh("GET", `/repos/${repo}/issues/${issueNo}`);
  const issue = res.ok ? await res.json() : null;
  const at = issue?.user?.login ? `@${issue.user.login} ` : "";
  await gh("POST", `/repos/${repo}/issues/${issueNo}/comments`, { body: at + body });
}

if (state === "approved") {
  await add("已通过");
  await remove("待审核");
  await remove("已拒绝");
  await notifyIssue("✅ 审核通过，合并后即收录到插件市场。");
} else if (state === "changes_requested") {
  await add("已拒绝");
  await remove("待审核");
  await remove("已通过");
  const note = review.body?.trim() ? "\n\n> " + review.body.trim().replace(/\n/g, "\n> ") : "";
  await notifyIssue(
    `❌ 维护者请求修改：${note}\n\n请按意见修改脚本后，编辑本 issue 触发重新校验（或评论 \`/recheck\`）。`,
  );
}

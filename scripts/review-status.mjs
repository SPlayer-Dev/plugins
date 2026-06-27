/**
 * 维护者在 PR 提交 review 后，同步 PR 的审核状态标签
 *
 * approved → 已通过；changes_requested → 已拒绝。仅协作者的 review 会触发分支保护放行。
 */

import { readFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf-8"));
const number = event.pull_request.number;
const state = event.review.state;

const gh = (method, path, payload) =>
  fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
const add = (n) => gh("POST", `/repos/${repo}/issues/${number}/labels`, { labels: [n] });
const remove = (n) => gh("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(n)}`);

if (state === "approved") {
  await add("已通过");
  await remove("待审核");
  await remove("已拒绝");
} else if (state === "changes_requested") {
  await add("已拒绝");
  await remove("待审核");
  await remove("已通过");
}

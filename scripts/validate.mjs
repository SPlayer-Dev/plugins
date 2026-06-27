/**
 * 仓库内全量校验：PR / 本地运行
 *
 * 校验所有 plugins/*.js：头部合法、@id 与文件名一致、id 唯一；敏感用法仅以 warning 提示。
 * 有任一错误则退出码 1。
 */

import { readdirSync, readFileSync } from "node:fs";
import { validate, DANGER_PATTERNS } from "./header.mjs";

const DIR = "plugins";
let failed = false;
const seen = new Set();

for (const file of readdirSync(DIR).filter((name) => name.endsWith(".js"))) {
  const id = file.slice(0, -3);
  if (seen.has(id)) {
    console.error(`${file}: 重复 id ${id}`);
    failed = true;
  }
  seen.add(id);

  const source = readFileSync(`${DIR}/${file}`, "utf-8");
  for (const err of validate(id, source).errors) {
    console.error(`${file}: ${err}`);
    failed = true;
  }
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(source)) console.log(`::warning file=${DIR}/${file}::疑似敏感用法 ${pattern}`);
  }
}

console.log(`校验 ${seen.size} 个插件，${failed ? "未通过" : "全部通过"}`);
process.exit(failed ? 1 : 0);

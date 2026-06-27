/**
 * 聚合 plugins/*.js 的头部生成 registry.json（App 拉取的市场索引）
 *
 * REPO_RAW 环境变量给出仓库 raw 前缀，updateUrl 即指向中央 raw，App 沿用既有
 * @updateUrl + @version 机制做一键更新。
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseHeader } from "./header.mjs";

const DIR = "plugins";
const RAW = process.env.REPO_RAW ?? "https://raw.githubusercontent.com/imsyy/splayer-plugins/main";

const plugins = readdirSync(DIR)
  .filter((name) => name.endsWith(".js"))
  .map((file) => {
    const header = parseHeader(readFileSync(`${DIR}/${file}`, "utf-8"));
    const id = file.slice(0, -3);
    return {
      id,
      name: header.name ?? id,
      author: header.author ?? "",
      type: header.type ?? "source",
      version: header.version ?? "0.0.0",
      description: header.description ?? "",
      homepage: header.homepage ?? "",
      updateUrl: `${RAW}/plugins/${file}`,
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

writeFileSync(
  "registry.json",
  JSON.stringify({ schema: 1, count: plugins.length, plugins }, null, 2) + "\n",
);
console.log(`已生成 registry.json：${plugins.length} 个插件`);

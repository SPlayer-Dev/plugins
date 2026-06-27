/**
 * 脚本头部解析与校验
 *
 * 与 SPlayer App 的 loader 同一套规则；市场端只做静态校验，不执行陌生人代码。
 */

/** 各字段长度上限 */
export const LIMITS = {
  id: 64,
  name: 24,
  description: 256,
  author: 56,
  version: 32,
  type: 16,
  apiLevel: 8,
  homepage: 256,
  updateUrl: 256,
};

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * 解析脚本头部 JSDoc 的 @字段
 * @param source - 脚本源码
 * @returns 字段键值表
 */
export function parseHeader(source) {
  const out = {};
  const block = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!block) return out;
  for (const line of block[1].split("\n")) {
    const matched = line.match(/^\s*\*\s*@(\w+)\s+(.+?)\s*$/);
    if (matched && matched[1] in LIMITS) out[matched[1]] = matched[2].slice(0, LIMITS[matched[1]]);
  }
  return out;
}

/**
 * 校验脚本源码本身（不涉及文件名）
 * @param source - 脚本源码
 * @returns id 解析出的 @id；header 全部字段；errors 错误数组（空=通过）
 */
export function validateSource(source) {
  const header = parseHeader(source);
  const errors = [];
  if (!header.id) errors.push("缺少 @id");
  else if (!ID_RE.test(header.id)) errors.push(`@id 非法：${header.id}`);
  if (!header.name) errors.push("缺少 @name");
  if ((header.type ?? "source") !== "control") errors.push("@type 需声明为 control");
  else if (!header.apiLevel || Number(header.apiLevel) < 2) errors.push("控制类插件需 @apiLevel ≥ 2");
  if (header.version && !/^\d+(\.\d+)*$/.test(header.version))
    errors.push(`@version 非法：${header.version}`);
  return { id: header.id, header, errors };
}

/**
 * 仓库内校验：在源码校验外，额外要求 @id 与文件名一致
 * @param id - 文件名去掉 .js 的部分
 * @param source - 脚本源码
 */
export function validate(id, source) {
  const result = validateSource(source);
  if (result.id && result.id !== id) result.errors.push(`@id（${result.id}）与文件名（${id}）不一致`);
  return result;
}

/** 仅供人工注意的敏感用法（沙箱才是真边界，这里只提示不拦截） */
export const DANGER_PATTERNS = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /child_process/,
  /process\.(env|exit|binding|mainModule)/,
  /require\s*\(\s*['"]/,
];

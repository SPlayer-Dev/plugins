/**
 * 脚本头部解析与校验
 *
 * 与 SPlayer App 的 loader 同一套规则；市场端只做静态校验，不执行陌生人代码。
 */

/** 各字段长度上限 */
export const LIMITS = {
  id: 64,
  grant: 64,
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
  if ((header.type ?? "source") !== "control") errors.push("脚本头需声明 @type control");
  else if (!header.apiLevel || Number(header.apiLevel) < 2) errors.push("控制类插件需 @apiLevel ≥ 2");
  if (header.version && !/^\d+(\.\d+)*$/.test(header.version))
    errors.push(`@version 非法：${header.version}`);
  // 权限：声明的 @grant 必须在白名单内；用到 request / 反向控制却没声明对应权限会在 App 端被拒，提前拦
  const grants = (header.grant ?? "")
    .split(/[,\s]+/)
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  for (const g of grants) {
    if (g !== "network" && g !== "control")
      errors.push(`未知权限 @grant：${g}（仅支持 network / control）`);
  }
  if (/\bsplayer\.request\b/.test(source) && !grants.includes("network"))
    errors.push("脚本用到 splayer.request，需声明 @grant network");
  if (
    /\bsplayer\.player\.(play|pause|next|prev|seek|setVolume|getPosition)\b/.test(source) &&
    !grants.includes("control")
  )
    errors.push("脚本用到 splayer.player.* 反向控制，需声明 @grant control");
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

/**
 * remote 版本是否严格高于 current：点分数字逐段比较，缺省段补 0，非数字段当 0
 * @param remote - 新版本号
 * @param current - 现版本号
 */
export function isNewerVersion(remote, current) {
  const parse = (v) =>
    String(v)
      .trim()
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((seg) => Number(seg) || 0);
  const a = parse(remote);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 仅供人工注意的敏感用法（沙箱才是真边界，这里只提示不拦截） */
export const DANGER_PATTERNS = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /child_process/,
  /process\.(env|exit|binding|mainModule)/,
  /require\s*\(\s*['"]/,
];

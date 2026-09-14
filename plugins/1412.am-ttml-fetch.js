/**
 * @name        AM TTML Fetch
 * @id          1412.am-ttml-fetch
 * @version     1.0.2
 * @description 搜索 Apple Music 并获取 TTML 逐字歌词（含翻译 / 音译）
 * @author      1412
 * @type        source
 * @apiLevel    1
 * @grant       network
 * @updateUrl   https://raw.githubusercontent.com/kid141252010/am-ttml-fetch/main/am-ttml-fetch.js
 * @changelog   新增「同 ISRC 孪生单曲逐字自愈回退」与「Single 版优先排序」：当专辑版仅有逐行歌词时，自动拉取并无缝升级为单曲版（Single）的原生 TTML 逐字歌词
 */

/* ========================= 常规默认配置 =========================
 * 插件已在 splayer.register 中注册了图形化设置界面。
 * 建议直接在 SPlayer-Next 的「设置 → 插件 → Apple Music TTML → 配置」中填写。
 * 此处的常量作为 GUI 设置项未填写时的兜底默认值。
 * ============================================================ */

/**
 * Media-User-Token：取歌词必需，搜索不需要
 * 浏览器登录 music.apple.com → F12 → 应用/Application → Cookie → 复制 media-user-token 的值
 * 需要 Apple Music 订阅；退出登录或改密码会失效，失效后重新复制一次
 */
const MEDIA_USER_TOKEN = "";

/**
 * 匹配容错档位：strict 严格 / standard 标准（推荐）/ loose 宽松
 * 详见下方 MATCH_LEVELS 说明
 */
const MATCH_LEVEL = "standard";

/**
 * 原文曲库：账号地区曲库会把中日韩曲名译成英文导致匹配不上，
 * 这里指定保留原文的曲库一起搜索，逗号分隔。默认 cn,tw,jp
 */
const SEARCH_REGIONS = "cn,tw,jp";

/** 歌词翻译 / 音译语言标签，留空则只取原文 */
const TRANSLATION_LANG = "zh-Hans-CN";

/** 歌词音译 / 脚本标签（l[script]），留空自动由语言标签截取推导 */
const TRANSLATION_SCRIPT = "";

/** 自定义歌手 / 专辑 / 歌名别名映射库，格式为 原词=别名，分号或逗号分隔 */
const CUSTOM_ALIAS_MAP = "五月天=Mayday, 茄子蛋=EggPlantEgg, 告五人=Accusefive";

/** 账号曲库地区，留空自动读取。歌词只存在于账号所属地区曲库，填错会全部取不到 */
const STOREFRONT = "";

/** 是否接受逐行歌词：默认 false（关闭，仅获取逐字歌词） */
const ACCEPT_LINE_LYRICS = false;

/* ======================= 配置声明结束 ======================= */

/** amp-api 校验 Origin，缺失一律 401 */
const AMP_ORIGIN = "https://music.apple.com";
const AMP_BASE = "https://amp-api.music.apple.com/v1";

/** 开发者 token 藏在 web 播放器主 bundle 里，取回后按 exp 缓存复用 */
const WEB_HOME = "https://music.apple.com/";
const BUNDLE_RE = /["'](\/assets\/index~[A-Za-z0-9]+\.js)["']/;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** 单个曲库的搜索条数 */
const SEARCH_LIMIT = 10;

/** 歌词缓存条目上限，超出按写入顺序淘汰 */
const LYRIC_CACHE_MAX = 50;

/** 单个曲库搜索的超时保护（毫秒），避免个别曲库长尾延迟阻塞全部搜索 */
const SEARCH_SINGLE_TIMEOUT = 4500;

/** 负缓存标记：标记无逐字歌词或纯逐行歌词（兼容旧版本缓存） */
const NO_SYLLABLE_MARKER = "__NO_SYLLABLE__";

/** 负缓存标记：标记曲库中无任何歌词（如 404），避免切歌时重复发起多重请求 */
const NO_LYRIC_MARKER = "__NO_LYRIC__";

/**
 * 匹配容错档位
 *
 * 打分与门槛都在宿主侧，插件唯一的调节手段是上报候选时补不补歌手别名
 * （Apple 常用本名 / 罗马字，与其它平台写法对不上，宿主的歌手门槛会拒掉本该采纳的候选）：
 * - strict：原样上报 Apple 数据，歌手写法不一致就放弃
 * - standard：候选曲名与关键词开头完全吻合时补别名
 * - loose：曲名带 (Live) 等后缀、只与关键词共享前缀时也补别名
 */
const MATCH_LEVELS = {
  strict: { alias: "off" },
  standard: { alias: "exact" },
  loose: { alias: "prefix" },
};

/** loose 档下，曲名与关键词的公共前缀至少要有这么长才认为指向同一首歌 */
const MIN_COMMON_PREFIX = 2;

splayer.register({
  sources: {
    am: {
      name: "Apple Music",
      actions: ["musicSearch", "musicLyric"],
      qualities: [],
    },
  },
  settings: [
    {
      key: "mediaUserToken",
      type: "text",
      label: "Media-User-Token",
      description: "Apple Music 登录 Token（Cookie 中以 0.Avks... 开头，取歌词必需）",
      default: "",
      placeholder: "粘贴 media-user-token 字符串",
    },
    {
      key: "storefront",
      type: "text",
      label: "账号曲库地区",
      description: "订阅账号所属 2 位地区代码（如 cn, us, ca, jp），留空自动获取",
      default: "",
      placeholder: "留空自动读取",
    },
    {
      key: "matchLevel",
      type: "select",
      label: "匹配容错档位",
      description: "歌手别名补偿策略（针对 Apple 歌手译名差异）",
      default: "standard",
      options: [
        { label: "严格 (strict) - 不补偿歌手别名", value: "strict" },
        { label: "标准 (standard) - 推荐，曲名精确吻合时补别名", value: "standard" },
        { label: "宽松 (loose) - 允许带 (Live) 等后缀匹配时补别名", value: "loose" },
      ],
    },
    {
      key: "searchRegions",
      type: "text",
      label: "原文辅助搜索曲库",
      description: "保留原文搜索的地区列表（逗号分隔），防止中日韩曲名被自动英译后匹配失败",
      default: "cn,tw,jp",
      placeholder: "cn,tw,jp",
    },
    {
      key: "translationLang",
      type: "text",
      label: "歌词翻译/语言 (l[lyrics])",
      description: "请求歌词时的语言标签（如 zh-Hans-CN），留空只获取原文",
      default: "zh-Hans-CN",
      placeholder: "zh-Hans-CN",
    },
    {
      key: "translationScript",
      type: "text",
      label: "歌词音译/脚本 (l[script])",
      description: "歌词音译或字形体系（如 Japanese, Romaji, zh-Hans），留空自动推导",
      default: "",
      placeholder: "留空自动推导",
    },
    {
      key: "acceptLineLyrics",
      type: "switch",
      label: "是否接受逐行歌词",
      description: "默认关闭（仅获取逐字歌词）。开启后，display=2 等普通逐行歌词也不作屏蔽，传给 SPlayer Next",
      default: false,
    },
    {
      key: "customAliasMap",
      type: "text",
      label: "自定义匹配别名库",
      description: "格式为「原词=别名」，逗号或换行分隔（如 五月天=Mayday, 茄子蛋=EggPlantEgg）。用于外区搜索与准确比对",
      default: "五月天=Mayday, 茄子蛋=EggPlantEgg, 告五人=Accusefive",
      placeholder: "五月天=Mayday, 茄子蛋=EggPlantEgg",
    },
  ],
});

/** 解析用户配置的自定义别名映射清单 [{ raw, alias }, ...] */
const getCustomAliasEntries = () => {
  const str = getSettingOrConst("customAliasMap", CUSTOM_ALIAS_MAP);
  if (!str) return [];
  const items = String(str).split(/[\n,;]+/);
  const entries = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const raw = trimmed.slice(0, eqIndex).trim();
      const alias = trimmed.slice(eqIndex + 1).trim();
      if (raw && alias) {
        entries.push({ raw, alias });
      }
    }
  }
  return entries;
};

/** 优先读取图形设置界面的值，若未配置或为空则使用脚本静态常量 */
const getSettingOrConst = (key, fallbackConst) => {
  const val = splayer.getSetting(key);
  if (val !== undefined && val !== null && String(val).trim() !== "") {
    return String(val).trim();
  }
  return fallbackConst;
};

/** 读取布尔类型设置项，优先读取图形设置界面的值，若未配置则使用脚本静态常量 */
const getBooleanSetting = (key, fallbackConst) => {
  const val = splayer.getSetting(key);
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1") return true;
    if (trimmed === "false" || trimmed === "0") return false;
  }
  return Boolean(fallbackConst);
};

/** base64url 解码为字符串 */
const decodeBase64Url = (input) => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
};

/** 读取 JWT 载荷，非法则返回 null */
const readJwtPayload = (token) => {
  try {
    return JSON.parse(decodeBase64Url(token.split(".")[1]));
  } catch {
    return null;
  }
};

/** 带鉴权头请求 amp-api */
const ampRequest = async (path, devToken, mediaUserToken, timeoutMs) => {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${devToken}`,
    Origin: AMP_ORIGIN,
  };
  if (mediaUserToken) headers["Media-User-Token"] = mediaUserToken;
  const opts = { headers, responseType: "json" };
  if (timeoutMs) opts.timeout = timeoutMs;
  const resp = await splayer.request(`${AMP_BASE}${path}`, opts);
  return { status: resp.status, body: resp.body };
};

/**
 * 从 web 端 bundle 里抓可用的开发者 token
 * bundle 内混有多个签发方的 JWT，AMPWebPlay 优先，逐个探测直到接口放行
 * @returns token 与过期时间戳（秒）
 */
const fetchDevToken = async () => {
  const home = await splayer.request(WEB_HOME, { timeout: 20_000 });
  const bundlePath = BUNDLE_RE.exec(String(home.body ?? ""))?.[1];
  if (!bundlePath) throw new Error("未能在首页定位到 web player bundle");

  const bundle = await splayer.request(`${AMP_ORIGIN}${bundlePath}`, { timeout: 45_000 });
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set();
  const candidates = [];
  for (const token of String(bundle.body ?? "").match(JWT_RE) ?? []) {
    if (seen.has(token)) continue;
    seen.add(token);
    const payload = readJwtPayload(token);
    if (!payload?.exp || payload.exp <= now) continue;
    candidates.push({ token, exp: payload.exp, iss: payload.iss });
  }
  if (candidates.length === 0) throw new Error("bundle 中没有未过期的开发者 token");
  candidates.sort((a, b) => Number(b.iss === "AMPWebPlay") - Number(a.iss === "AMPWebPlay"));

  for (const candidate of candidates) {
    const probe = await ampRequest(
      "/catalog/us/search?term=a&types=songs&limit=1",
      candidate.token,
    );
    if (probe.status === 200) return candidate;
  }
  throw new Error("bundle 中的开发者 token 均被拒绝");
};

/** 进程内 token 缓存，避免同一次会话反复读 storage */
let devTokenCache = null;
let devTokenTask = null;

/**
 * 取可用的开发者 token
 * 顺序：内存 → storage → 重新抓取；并发调用共享同一次抓取
 * @param force - 忽略缓存强制重取（token 被服务端提前作废时用）
 */
const getDevToken = async (force = false) => {
  const now = Math.floor(Date.now() / 1000);
  // 留 5 分钟余量，避免边界期取到刚过期的 token
  const valid = (entry) => entry?.token && entry.exp - 300 > now;

  if (!force && valid(devTokenCache)) return devTokenCache.token;
  if (!force) {
    const stored = await splayer.storage.get("devToken");
    if (valid(stored)) {
      devTokenCache = stored;
      return stored.token;
    }
  }
  if (!devTokenTask) {
    devTokenTask = fetchDevToken()
      .then(async (entry) => {
        devTokenCache = entry;
        await splayer.storage.set("devToken", entry);
        splayer.log.info(`开发者 token 已就绪，issuer=${entry.iss}`);
        return entry.token;
      })
      .finally(() => {
        devTokenTask = null;
      });
  }
  return devTokenTask;
};

/** 读取用户配置或脚本顶部的 Media-User-Token */
const requireMediaUserToken = () => {
  const token = getSettingOrConst("mediaUserToken", MEDIA_USER_TOKEN);
  if (!token) {
    throw new Error(
      "请先在插件设置中填写 Media-User-Token（设置 → 插件 → Apple Music TTML → 配置）",
    );
  }
  return token;
};

/**
 * 请求 amp-api，401 时重取一次开发者 token 后重试；
 * 遇到偶发网络中断/重置 (ECONNRESET) 时自愈重试 1 次
 */
const ampRequestWithRetry = async (path, mediaUserToken, timeoutMs) => {
  const send = async (token) => {
    try {
      return await ampRequest(path, token, mediaUserToken, timeoutMs);
    } catch (err) {
      if (/network|reset|econnreset|timeout/i.test(err?.message ?? "")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return await ampRequest(path, token, mediaUserToken, timeoutMs);
      }
      throw err;
    }
  };

  let resp = await send(await getDevToken());
  if (resp.status === 401) {
    resp = await send(await getDevToken(true));
  }
  return resp;
};

/**
 * 取账号所属曲库地区
 * 用户显式填写优先，否则读账号地区并按 token 缓存
 */
const getAccountStorefront = async (mediaUserToken) => {
  const manual = getSettingOrConst("storefront", STOREFRONT).toLowerCase();
  if (manual) return manual;

  const md5Fn = (splayer.crypto || splayer.utils?.crypto)?.md5;
  const cacheKey = `storefront:${md5Fn ? md5Fn(mediaUserToken) : mediaUserToken}`;
  const cached = await splayer.storage.get(cacheKey);
  if (cached) return cached;

  const resp = await ampRequestWithRetry("/me/storefront", mediaUserToken);
  const storefront = resp.body?.data?.[0]?.id;
  if (!storefront) {
    throw new Error(`无法读取账号地区（HTTP ${resp.status}），请检查 Media-User-Token 是否有效`);
  }
  await splayer.storage.set(cacheKey, storefront);
  splayer.log.info(`账号曲库地区：${storefront}`);
  return storefront;
};

/** 解析原文曲库列表，账号地区置首（它的 id 能直接取词，无需桥接） */
const getSearchStorefronts = (accountStorefront) => {
  const regions = getSettingOrConst("searchRegions", SEARCH_REGIONS);
  const extra = String(regions ?? "")
    .toLowerCase()
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== accountStorefront);
  return [accountStorefront, ...new Set(extra)];
};

/** 读取匹配容错档位，未识别的值退回标准档 */
const getMatchLevel = () => {
  const levelKey = getSettingOrConst("matchLevel", MATCH_LEVEL);
  return MATCH_LEVELS[levelKey] ?? MATCH_LEVELS.standard;
};

/** 与宿主 normalize 对齐，用于比对曲名并从关键词里剥出歌手（强化 Unicode NFC、标点、全角符号与省略号） */
const normalize = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[、&;，,/|()（）\[\]【】{}《》·・\s\-_'"`~!?？！.。…\^]+/g, "");

/** 合作伴唱后缀正则：支持带括号 ((feat. xxx), [with xxx]) 及无括号的独立伴唱 ( feat.xxx, feat xxx) */
const FEAT_PATTERN =
  /(?:[\(\（\[\【]\s*(?:feat|ft|featuring|with)\b[^\)\）\]\】]*[\)\）\]\】]|(?:\s+|^)(?:feat|ft|featuring|with)\b\.?\s*[^\s\(\[\{]+)/gi;

/** 剥离曲名或关键词中的 feat / with 等伴唱后缀 */
const stripFeat = (text) => String(text ?? "").replace(FEAT_PATTERN, "").trim();

/** 从曲名或文本中提取 feat / with 里的合作伴唱歌手名列表 */
const extractFeatArtists = (text) => {
  const matches = String(text ?? "").match(FEAT_PATTERN);
  if (!matches) return [];
  const artists = [];
  for (const m of matches) {
    const cleaned = m
      .replace(/[\(\（\[\【\)\）\]\】]/g, "")
      .replace(/^(?:feat|ft|featuring|with)\b\.?\s*/i, "")
      .trim();
    if (cleaned) {
      artists.push(...cleaned.split(/[,/&、+]/).map((s) => s.trim()).filter(Boolean));
    }
  }
  return artists;
};

/**
 * 从搜索关键词里剥出歌手部分
 *
 * 宿主关键词为 `歌名 + 歌手`，候选曲名与关键词开头吻合时，余下即宿主看到的歌手写法。
 * Apple 常用歌手本名或罗马字（买辣椒也用券 → 冯沁苑LaJiao），与其它平台写法对不上，
 * 宿主的歌手门槛会因此拒掉本可采纳的候选；此处把宿主自己的写法作为别名补回去。
 * @param mode - off 不补 / exact 曲名须为关键词前缀 / prefix 允许曲名带后缀
 * @returns 歌手别名，无法可靠剥出时返回空串
 */
const deriveArtistAlias = (keyword, candidateName, mode) => {
  if (mode === "off") return "";
  const cleanKw = stripFeat(keyword);
  const flatKeyword = normalize(cleanKw);
  const flatName = normalize(stripFeat(candidateName));
  if (!flatName) return "";

  if (flatKeyword.startsWith(flatName)) {
    const rest = flatKeyword.slice(flatName.length);
    return rest.length >= 2 ? rest : "";
  }
  if (mode !== "prefix") return "";

  // 曲名带 (Live) 等后缀时与关键词只共享前缀，公共部分够长才认为是同一首
  let common = 0;
  while (common < flatName.length && common < flatKeyword.length) {
    if (flatName[common] !== flatKeyword[common]) break;
    common++;
  }
  if (common < MIN_COMMON_PREFIX) return "";
  const rest = flatKeyword.slice(common);
  return rest.length >= 2 ? rest : "";
};

/** 在单个曲库里搜候选，失败或超时不影响其它曲库 */
const searchStorefront = async (storefront, keyword, mediaUserToken) => {
  const path = `/catalog/${storefront}/search?term=${encodeURIComponent(keyword)}&types=songs&limit=${SEARCH_LIMIT}`;
  const resp = await ampRequestWithRetry(path, mediaUserToken, SEARCH_SINGLE_TIMEOUT);
  if (resp.status !== 200) {
    splayer.log.warn(`搜索失败 sf=${storefront} HTTP ${resp.status}`);
    return [];
  }
  const list = [];
  for (const item of resp.body?.results?.songs?.data ?? []) {
    const attrs = item.attributes ?? {};
    if (!attrs.hasLyrics) continue;
    list.push({
      id: String(item.id),
      name: attrs.name ?? "",
      singer: attrs.artistName ?? "",
      album: attrs.albumName ?? "",
      durationMs: attrs.durationInMillis,
      releaseDate: attrs.releaseDate ?? "",
      storefront,
      isrc: attrs.isrc ?? "",
      hasTimeSyncedLyrics: Boolean(attrs.hasTimeSyncedLyrics),
    });
  }
  return list;
};

/** 时长足够接近，视为同一录音 */
const sameRecording = (leftMs, rightMs) =>
  Boolean(leftMs) && Boolean(rightMs) && Math.abs(leftMs - rightMs) <= 2000;

/** HOYO-MiX 官方 Artist ID（全球各曲库一致） */
const HOYOMIX_ARTIST_ID = "1447413190";

/** 判断艺人文本是否包含 HOYO-MiX */
const isHoyoMixArtist = (text) => /hoyo-?mix/i.test(String(text ?? ""));

/** 伴奏/和声伴奏/纯音过滤正则 */
const INSTRUMENTAL_RE =
  /\b(instrumental|harmonic\s*accompaniment|karaoke|off\s*vocal)\b|[\(（\[【](?:伴奏|和声伴奏|纯音|纯乐)[\)）\]】]/i;

/** 判定是否为伴奏或无词版本 */
const isInstrumentalOrNoLyric = (track) => {
  if (track.hasLyrics === false) return true;
  if (INSTRUMENTAL_RE.test(track.name)) return true;
  return false;
};

/** HOYO-MiX 歌手页专辑缓存（storefront -> { expireAt, albums }）与并发防抖任务 */
const hoyoMixAlbumsCache = new Map();
const hoyoMixAlbumsTasks = new Map();
const HOYOMIX_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时持久缓存

/**
 * 获取单张专辑的曲目列表（若该专辑未内嵌 tracks 时按需调用）
 */
const fetchAlbumTracks = async (storefront, albumId, mediaUserToken) => {
  try {
    const path = `/catalog/${storefront}/albums/${albumId}/tracks`;
    const resp = await ampRequestWithRetry(path, mediaUserToken, 5000);
    if (resp.status !== 200) return [];
    return (resp.body?.data ?? []).map((t) => {
      const tAttrs = t.attributes ?? {};
      return {
        id: String(t.id),
        name: tAttrs.name ?? "",
        singer: tAttrs.artistName ?? "",
        durationMs: tAttrs.durationInMillis,
        isrc: tAttrs.isrc ?? "",
        hasLyrics: Boolean(tAttrs.hasLyrics),
        hasTimeSyncedLyrics: Boolean(tAttrs.hasTimeSyncedLyrics),
      };
    });
  } catch (err) {
    splayer.log.warn(`获取专辑 tracks 失败 sf=${storefront} album=${albumId}`, err?.message);
    return [];
  }
};

/**
 * 全量获取账号曲库中 HOYO-MiX 自 2018 年以来的所有专辑/EP/Single/合辑
 * 自动翻页覆盖全部（目前 150+ 张），第 1 页自带最新 tracks，老专辑按需拉取 tracks 并缓存
 */
const fetchHoyoMixAlbums = async (storefront, mediaUserToken) => {
  const now = Date.now();
  const cached = hoyoMixAlbumsCache.get(storefront);
  if (cached && cached.expireAt > now) {
    return cached.albums;
  }
  // 检查 storage 持久缓存
  const stored = await splayer.storage.get(`hoyoMixAlbums:${storefront}`);
  if (stored && stored.expireAt > now && Array.isArray(stored.albums) && stored.albums.length > 0) {
    hoyoMixAlbumsCache.set(storefront, stored);
    return stored.albums;
  }

  if (hoyoMixAlbumsTasks.has(storefront)) {
    return hoyoMixAlbumsTasks.get(storefront);
  }

  const task = (async () => {
    try {
      const albums = [];
      let offset = 0;
      while (true) {
        // 第 1 页（最新 100 张发行）直接 include=tracks，后续历史发行极速拉取专辑元数据
        const includeParam = offset === 0 ? "&include=tracks" : "";
        const path = `/catalog/${storefront}/artists/${HOYOMIX_ARTIST_ID}/albums?offset=${offset}&limit=100&sort=-releaseDate${includeParam}`;
        const resp = await ampRequestWithRetry(path, mediaUserToken, 8000);
        if (resp.status !== 200) {
          splayer.log.warn(`获取 HOYO-MiX 专辑列表失败 sf=${storefront} offset=${offset} HTTP ${resp.status}`);
          break;
        }
        const items = resp.body?.data ?? [];
        if (items.length === 0) break;

        for (const item of items) {
          const attrs = item.attributes ?? {};
          const tracksData = item.relationships?.tracks?.data;
          const tracks = tracksData
            ? tracksData.map((t) => {
                const tAttrs = t.attributes ?? {};
                return {
                  id: String(t.id),
                  name: tAttrs.name ?? "",
                  singer: tAttrs.artistName ?? "",
                  durationMs: tAttrs.durationInMillis,
                  isrc: tAttrs.isrc ?? "",
                  hasLyrics: Boolean(tAttrs.hasLyrics),
                  hasTimeSyncedLyrics: Boolean(tAttrs.hasTimeSyncedLyrics),
                };
              })
            : null;

          albums.push({
            id: String(item.id),
            name: attrs.name ?? "",
            releaseDate: attrs.releaseDate ?? "",
            tracks,
          });
        }

        if (items.length < 100) break;
        offset += items.length;
      }

      splayer.log.info(`HOYO-MiX 全量专辑清单已就绪，共 ${albums.length} 张发行 (sf=${storefront})`);
      const cacheEntry = { expireAt: now + HOYOMIX_CACHE_TTL, albums };
      hoyoMixAlbumsCache.set(storefront, cacheEntry);
      splayer.storage.set(`hoyoMixAlbums:${storefront}`, cacheEntry).catch(() => {});
      return albums;
    } catch (err) {
      splayer.log.warn(`获取 HOYO-MiX 专辑异常 sf=${storefront}`, err?.message);
      return [];
    } finally {
      hoyoMixAlbumsTasks.delete(storefront);
    }
  })();

  hoyoMixAlbumsTasks.set(storefront, task);
  return task;
};

/**
 * 专为 HOYO-MiX 设计的跨区同录音对齐逻辑：
 * 在账号曲库的 HOYO-MiX 歌手页中直接寻找同发售日期的专辑/EP/Single/合辑，
 * 严格过滤伴奏与和声伴奏，精准比对录音时长与歌手
 */
const matchHoyoMixAccountTrack = async (cand, accountStorefront, mediaUserToken) => {
  if (!cand || !isHoyoMixArtist(cand.singer)) return null;

  const albums = await fetchHoyoMixAlbums(accountStorefront, mediaUserToken);
  if (!albums || albums.length === 0) return null;

  const candDate = cand.releaseDate;
  const matched = [];

  for (const album of albums) {
    let isExactDate = false;
    let isCloseDate = false;
    if (candDate) {
      if (album.releaseDate === candDate) {
        isExactDate = true;
      } else if (album.releaseDate) {
        const diffDays = Math.abs(new Date(album.releaseDate) - new Date(candDate)) / 86400000;
        if (diffDays <= 1.1) isCloseDate = true;
      }
    }
    if (candDate && !isExactDate && !isCloseDate) continue;

    // 若老专辑未内嵌 tracks，按需只拉取命中日期的这 1~2 张专辑的曲目
    let tracks = album.tracks;
    if (!tracks) {
      tracks = await fetchAlbumTracks(accountStorefront, album.id, mediaUserToken);
      album.tracks = tracks;
    }

    for (const track of tracks) {
      // 1. 严格忽略伴奏版（Instrumental、Harmonic Accompaniment、伴奏、纯音）与无词版本
      if (isInstrumentalOrNoLyric(track)) continue;

      // 2. 时长精准比对（误差 2 秒内）
      if (!sameRecording(track.durationMs, cand.durationMs)) continue;

      matched.push({
        track,
        album,
        isExactDate,
        hasTimeSyncedLyrics: track.hasTimeSyncedLyrics,
      });
    }
  }

  if (matched.length === 0) return null;

  // 排序优先：完全同发售日期 > 具备逐字/逐行歌词
  matched.sort((a, b) => {
    if (a.isExactDate !== b.isExactDate) return a.isExactDate ? -1 : 1;
    if (a.hasTimeSyncedLyrics !== b.hasTimeSyncedLyrics) return a.hasTimeSyncedLyrics ? -1 : 1;
    return 0;
  });

  const best = matched[0].track;
  splayer.log.info(
    `HOYO-MiX 歌手页同日期对齐成功: [${cand.name}](${cand.storefront}) -> [${best.name}](${accountStorefront} id=${best.id})`,
  );
  return best;
};

splayer.on("musicSearch", async ({ keyword }) => {
  const mediaUserToken = requireMediaUserToken();
  const accountStorefront = await getAccountStorefront(mediaUserToken);
  const storefronts = getSearchStorefronts(accountStorefront);
  const aliasEntries = getCustomAliasEntries();

  // 1. 基础词与剥离 feat 伴唱后的派生词
  const searchKeywords = [keyword];
  const cleanKeyword = stripFeat(keyword);
  if (cleanKeyword && cleanKeyword !== keyword && !searchKeywords.includes(cleanKeyword)) {
    searchKeywords.push(cleanKeyword);
  }

  // 1.1 进一步剥离省略号及外层括号的精简搜索词（应对《（……侏儒之舞）》类特殊符号歌曲）
  const simplifiedKeyword = cleanKeyword
    .replace(/^[\(\（\[\【\s…\.]+|[\)\）\]\】\s…\.]+$/g, "")
    .trim();
  if (
    simplifiedKeyword &&
    simplifiedKeyword !== cleanKeyword &&
    !searchKeywords.includes(simplifiedKeyword)
  ) {
    searchKeywords.push(simplifiedKeyword);
  }

  // 2. 若关键词命中了自定义别名映射（如 "五月天" -> "Mayday"），自动追加衍生词并发搜索
  const currentKeywords = [...searchKeywords];
  for (const kw of currentKeywords) {
    for (const entry of aliasEntries) {
      if (kw.toLowerCase().includes(entry.raw.toLowerCase())) {
        const expanded = kw.replace(new RegExp(entry.raw, "gi"), entry.alias);
        if (!searchKeywords.includes(expanded)) searchKeywords.push(expanded);
      } else if (kw.toLowerCase().includes(entry.alias.toLowerCase())) {
        const expanded = kw.replace(new RegExp(entry.alias, "gi"), entry.raw);
        if (!searchKeywords.includes(expanded)) searchKeywords.push(expanded);
      }
    }
  }

  // 对原词及别名扩充词在各曲库并发搜索（各曲库自带短超时保护）
  const searchTasks = [];
  for (const kw of searchKeywords) {
    for (const sf of storefronts) {
      searchTasks.push(
        searchStorefront(sf, kw, mediaUserToken).catch((err) => {
          splayer.log.warn(`搜索异常 sf=${sf} kw=${kw}`, err?.message);
          return [];
        }),
      );
    }
  }
  const groups = await Promise.all(searchTasks);
  const all = groups.flat();
  const accountItems = all.filter((item) => item.storefront === accountStorefront);
  const flatKeyword = normalize(cleanKeyword || keyword);

  // 同一 catalog id 在各曲库是同一录音、仅曲名本地化不同；按 id 合并，
  // 取「曲名核心恰为宿主关键词前缀」的那份，宿主的曲名门槛才过得去
  const merged = new Map();
  for (const item of all) {
    const kept = merged.get(item.id);
    if (!kept) {
      merged.set(item.id, { ...item, inAccount: item.storefront === accountStorefront });
      continue;
    }
    kept.inAccount = kept.inAccount || item.storefront === accountStorefront;
    const keptMatches = flatKeyword.startsWith(normalize(stripFeat(kept.name)));
    if (!keptMatches && flatKeyword.startsWith(normalize(stripFeat(item.name)))) {
      kept.name = item.name;
      kept.singer = item.singer;
      kept.album = item.album;
    }
  }

  const level = getMatchLevel();
  const list = [];
  for (const item of merged.values()) {
    // 不在账号库的候选：优先按 ISRC 精准匹配，次选按时长认领账号库同录音；
    // 取词时可直接使用该 ID，彻底免去额外的跨区桥接网络请求！
    if (!item.inAccount) {
      let twin = null;
      if (item.isrc) {
        twin = accountItems.find((cand) => cand.isrc && cand.isrc === item.isrc);
      }
      if (!twin) {
        twin = accountItems.find((cand) => sameRecording(cand.durationMs, item.durationMs));
      }
      // HOYO-MiX 特殊通道：若账号库未通过常规方式认领，立即在 HOYO-MiX 歌手页寻找同日期非伴奏同录音！
      if (!twin && isHoyoMixArtist(item.singer)) {
        const hoyoTrack = await matchHoyoMixAccountTrack(item, accountStorefront, mediaUserToken);
        if (hoyoTrack) twin = hoyoTrack;
      }
      if (twin) {
        item.accountId = twin.id;
        splayer.storage.set(`bridge:${accountStorefront}:${item.storefront}:${item.id}`, twin.id).catch(() => {});
      }
    }

    // 自动提取曲名中的 feat / with 伴唱歌手，合并进 candidate.singer，
    // 解决 Apple 将 feat 写在歌名中导致宿主按合作歌手匹配失败的问题
    const featArtists = extractFeatArtists(item.name);
    let singer = item.singer;
    for (const fa of featArtists) {
      if (!singer.split(/[\/,;&、，]+/).some((s) => normalize(s) === normalize(fa))) {
        singer = `${singer}/${fa}`;
      }
    }

    const alias = deriveArtistAlias(keyword, item.name, level.alias);
    if (alias) {
      singer = `${singer}/${alias}`;
    }

    // 根据自定义别名映射表（如 五月天=Mayday），自动双向补全别名
    for (const entry of aliasEntries) {
      const normSinger = normalize(singer);
      const normRaw = normalize(entry.raw);
      const normAlias = normalize(entry.alias);
      if (normSinger.includes(normRaw) && !singer.split("/").includes(entry.alias)) {
        singer = `${singer}/${entry.alias}`;
      } else if (normSinger.includes(normAlias) && !singer.split("/").includes(entry.raw)) {
        singer = `${singer}/${entry.raw}`;
      }
    }

    // 智能曲名对齐：当候选的核心歌名与关键词的核心歌名吻合时，
    // 精准将候选名称对齐为搜索关键词中的曲名格式（完全保持与宿主一致的全角括号、feat 等标点写法），
    // 彻底解决宿主由于未过滤全角括号（）和中括号[]导致比对失败的致命问题！
    let name = item.name;
    const cleanCand = normalize(stripFeat(item.name));
    const cleanKw = normalize(stripFeat(keyword));
    if (cleanCand && (cleanKw.startsWith(cleanCand) || cleanCand.startsWith(cleanKw))) {
      const featMatches = keyword.match(FEAT_PATTERN);
      if (featMatches && featMatches[0]) {
        // 宿主关键词中显式带有 feat 标记，精确截取到 feat 标记结束
        const featIdx = keyword.indexOf(featMatches[0]);
        name = keyword.slice(0, featIdx + featMatches[0].length).trim();
      } else {
        // 宿主关键词中未带 feat（例如歌名是纯标题，合作歌手全放在 artist 字段传过来），
        // 循环从关键词末尾剥离所有匹配的歌手（含主唱与提取出的伴唱）
        let rawTitle = keyword.trim();
        const artistParts = singer.split(/[\/,;&、，]+/).map((a) => a.trim()).filter(Boolean);
        let changed = true;
        while (changed) {
          changed = false;
          for (const artist of artistParts) {
            if (rawTitle.toLowerCase().endsWith(artist.toLowerCase())) {
              rawTitle = rawTitle.slice(0, -artist.length).trim();
              changed = true;
            }
          }
        }
        // 剥离完歌手后，若剩余标题的核心词依然与候选一致，则采用宿主原生标题格式；否则使用剥离 feat 后的候选曲名
        if (rawTitle && normalize(rawTitle) === cleanCand) {
          name = rawTitle;
        } else {
          name = stripFeat(item.name);
        }
      }
    }

    list.push({ ...item, name, singer });
  }

  // 关键排序：
  // 1. 非 Live 关键词下，优先录音室正式版排在前面，防止被 Live 现场版抢占
  // 2. 具备逐字标签优先
  // 3. 具备 Single/单曲 标识优先（Apple 官方单曲版往往更早制作且具备完整的逐字时间戳）
  const isKeywordLive = /\blive\b/i.test(keyword);
  list.sort((a, b) => {
    const aIsLive = /\blive\b/i.test(a.name) || /\blive\b/i.test(a.album);
    const bIsLive = /\blive\b/i.test(b.name) || /\blive\b/i.test(b.album);
    if (!isKeywordLive && aIsLive !== bIsLive) {
      return aIsLive ? 1 : -1;
    }
    if (a.hasTimeSyncedLyrics !== b.hasTimeSyncedLyrics) {
      return b.hasTimeSyncedLyrics ? 1 : -1;
    }
    const aSingle = /single|单曲|ep/i.test(a.album) || /single|单曲|ep/i.test(a.name);
    const bSingle = /single|单曲|ep/i.test(b.album) || /single|单曲|ep/i.test(b.name);
    if (aSingle !== bSingle) {
      return aSingle ? -1 : 1;
    }
    return 0;
  });

  return { list };
});

/**
 * 定位候选在账号曲库里的歌曲 id
 * 歌词只存在于账号所属曲库，原文库搜到的 id 直接取词多半 404
 * 顺序：搜索阶段认领的同录音 id → 缓存映射 → ISRC 直接反查 → 降级直接探测
 * @returns 账号曲库内的歌曲 id，定位不到返回 null
 */
const resolveAccountSongId = async (musicInfo, accountStorefront, mediaUserToken) => {
  if (musicInfo.inAccount || musicInfo.storefront === accountStorefront) return musicInfo.id;
  if (musicInfo.accountId) return String(musicInfo.accountId);

  const cacheKey = `bridge:${accountStorefront}:${musicInfo.storefront}:${musicInfo.id}`;
  const cached = await splayer.storage.get(cacheKey);
  if (cached) {
    if (cached !== "__NOT_FOUND__") return cached;
    // 若旧缓存是 __NOT_FOUND__，但属于 HOYO-MiX，允许打破旧缓存自愈重新探测
    if (!isHoyoMixArtist(musicInfo.singer)) return null;
  }

  // 0. HOYO-MiX 专属优先通道：直接在歌手页匹配同日期同录音，彻底解决中外曲名/ISRC双轨不一致问题
  if (isHoyoMixArtist(musicInfo.singer)) {
    if (!musicInfo.releaseDate) {
      try {
        const probe = await ampRequestWithRetry(
          `/catalog/${musicInfo.storefront}/songs/${musicInfo.id}`,
          mediaUserToken,
          SEARCH_SINGLE_TIMEOUT,
        );
        if (probe.status === 200) {
          musicInfo.releaseDate = probe.body?.data?.[0]?.attributes?.releaseDate ?? "";
        }
      } catch {}
    }
    const hoyoTrack = await matchHoyoMixAccountTrack(musicInfo, accountStorefront, mediaUserToken);
    if (hoyoTrack) {
      const id = String(hoyoTrack.id);
      await splayer.storage.set(cacheKey, id);
      return id;
    }
  }

  // 1. 优先通过 ISRC 直接反查账号库：
  // 经实测跨区 Catalog Song ID 互不通用，盲猜探测绝大多数返回 404（白等约 500ms）；
  // 而 ISRC 跨区精准统一，一步到位避免多重串行往返
  if (musicInfo.isrc) {
    const path = `/catalog/${accountStorefront}/songs?filter%5Bisrc%5D=${encodeURIComponent(musicInfo.isrc)}`;
    const resp = await ampRequestWithRetry(path, mediaUserToken);
    if (resp.status === 200) {
      const matches = (resp.body?.data ?? []).filter(
        (item) =>
          !musicInfo.durationMs ||
          sameRecording(item.attributes?.durationInMillis, musicInfo.durationMs),
      );
      const best =
        matches.find((item) => item.attributes?.hasTimeSyncedLyrics) ??
        matches.find((item) => item.attributes?.hasLyrics);
      if (best) {
        const id = String(best.id);
        await splayer.storage.set(cacheKey, id);
        return id;
      }
    }
  }

  // 2. 无 ISRC 或 ISRC 反查无果时，降级探测原 catalog id 在账号库是否通用
  const direct = await ampRequestWithRetry(
    `/catalog/${accountStorefront}/songs/${musicInfo.id}`,
    mediaUserToken,
  );
  if (direct.status === 200) {
    await splayer.storage.set(cacheKey, musicInfo.id);
    return musicInfo.id;
  }

  await splayer.storage.set(cacheKey, "__NOT_FOUND__");
  return null;
};

/** 从歌词响应里取出 TTML，带翻译的本地化版本优先 */
const pickTTML = (body) => {
  const attrs = body?.data?.[0]?.attributes;
  if (!attrs) return "";
  const localized = attrs.ttmlLocalizations;
  return String((typeof localized === "string" && localized) || attrs.ttml || "");
};

/**
 * 校验 TTML 是否为逐字歌词（Syllable-level）：
 * 只要主歌词中包含带有 begin 时间戳的 <span> 标签即为逐字歌词。
 * （注意：不能全局检查 itunes:timing="None"，因为内嵌的翻译段通常被 Apple 标记为 None）
 */
const isSyllableTTML = (ttml) => {
  if (!ttml || typeof ttml !== "string") return false;
  return /<span\b[^>]*\b(begin|end)\s*=/i.test(ttml);
};

/**
 * 预处理 TTML：将 Apple Music 的简体替换段 (translation type="replacement") 融合进主歌词中，
 * 严格保留背景歌词 (ttm:role="x-bg") 与逐字时间戳，清理冗余 xmlns 并更新根节点语言声明为 zh-Hans。
 *
 * @param {string} ttml - 原始 TTML 字符串
 * @returns {string} 处理后的 TTML 字符串
 */
const applyReplacementTranslations = (ttml) => {
  if (!ttml || typeof ttml !== "string") return ttml;

  // 1. 查找 replacement 类型的 translation 块（通常为 zh-Hans）
  const replacementRegex =
    /<translation\b[^>]*\btype=["']replacement["'][^>]*>([\s\S]*?)<\/translation>/i;
  const match = ttml.match(replacementRegex);
  if (!match) {
    return ttml;
  }

  const transTag = match[0];
  const replacementContent = match[1];

  // 解析替换段的语言声明（如 zh-Hans）
  const transLangMatch = transTag.match(/\bxml:lang=["']([^"']+)["']/i);
  const targetLang = transLangMatch ? transLangMatch[1] : "zh-Hans";

  // 2. 提取所有 <text for="KEY">CONTENT</text>，建立 key -> cleanContent 映射表
  const textRegex = /<text\b[^>]*\bfor=["']([^"']+)["'][^>]*>([\s\S]*?)<\/text>/gi;
  const replacementMap = new Map();

  let textMatch;
  while ((textMatch = textRegex.exec(replacementContent)) !== null) {
    const key = textMatch[1];
    let content = textMatch[2];

    // 清理 span 标签上冗余的 xmlns / xmlns:ttm / xmlns:itunes 属性，
    // 严格保留 ttm:role="x-bg"、begin、end 等业务属性与层级结构
    content = content.replace(/\s+xmlns(?::\w+)?=["'][^"']+["']/g, "");

    replacementMap.set(key, content);
  }

  if (replacementMap.size === 0) {
    return ttml;
  }

  // 3. 将主歌词中对应 <p itunes:key="KEY"> 的内部歌词替换为简体内容
  // 保留 <p> 标签自身的所有属性（begin, end, itunes:key, ttm:agent, ttm:role 等）
  let processedTtml = ttml.replace(
    /(<p\b([^>]*\bitunes:key=["']([^"']+)["'][^>]*)>)([\s\S]*?)(<\/p>)/gi,
    (fullMatch, openTag, attrs, key, originalContent, closeTag) => {
      const repContent = replacementMap.get(key);
      if (repContent !== undefined) {
        return `${openTag}${repContent}${closeTag}`;
      }
      return fullMatch;
    },
  );

  // 4. 移除已经应用融合的 <translation type="replacement"> 块
  processedTtml = processedTtml.replace(replacementRegex, "");

  // 若 <translations> 内部仅有空白字符，则移除空的 <translations></translations> 标签
  processedTtml = processedTtml.replace(/<translations>\s*<\/translations>/gi, "");

  // 5. 更新根节点 <tt> 的 xml:lang 声明为目标语言（如 zh-Hans）
  processedTtml = processedTtml.replace(
    /(<tt\b[^>]*\bxml:lang=["'])[^"']+([^>]*>)/i,
    `$1${targetLang}$2`,
  );

  return processedTtml;
};

/** 写入歌词缓存，按写入顺序淘汰最旧条目 */
const cacheLyric = async (key, ttml) => {
  const index = (await splayer.storage.get("lyricIndex")) ?? [];
  const next = index.filter((item) => item !== key);
  next.push(key);
  while (next.length > LYRIC_CACHE_MAX) {
    await splayer.storage.remove(next.shift());
  }
  await splayer.storage.set(key, ttml);
  await splayer.storage.set("lyricIndex", next);
};

/** 拼歌词请求的翻译 / 音译参数 */
const buildLyricQuery = (lang, script) => {
  const query = ["extend=ttmlLocalizations"];
  if (lang) {
    query.push(`l%5Blyrics%5D=${encodeURIComponent(lang)}`);
  }
  const finalScript = script || (lang ? lang.split("-").slice(0, 2).join("-") : "");
  if (finalScript) {
    query.push(`l%5Bscript%5D=${encodeURIComponent(finalScript)}`);
  }
  return `?${query.join("&")}`;
};

splayer.on("musicLyric", async ({ musicInfo }) => {
  const mediaUserToken = requireMediaUserToken();
  const accountStorefront = await getAccountStorefront(mediaUserToken);

  const songId = await resolveAccountSongId(musicInfo, accountStorefront, mediaUserToken);
  if (!songId) {
    splayer.log.warn(`候选不在账号曲库内，跳过 id=${musicInfo.id} sf=${musicInfo.storefront}`);
    return { lyric: "" };
  }

  const lang = getSettingOrConst("translationLang", TRANSLATION_LANG);
  const script = getSettingOrConst("translationScript", TRANSLATION_SCRIPT);
  const acceptLineLyrics = getBooleanSetting("acceptLineLyrics", ACCEPT_LINE_LYRICS);
  const cacheKey = `lyric:${accountStorefront}:${songId}:${lang}:${script}`;
  const cached = await splayer.storage.get(cacheKey);
  if (cached) {
    if (cached === NO_LYRIC_MARKER) {
      return { lyric: "" };
    }
    if (cached === NO_SYLLABLE_MARKER) {
      if (!acceptLineLyrics) {
        return { lyric: "" };
      }
      // 开启接受逐行歌词时，清除旧版本的负缓存标记以重新探测是否有逐行歌词
      await splayer.storage.remove(cacheKey);
    } else if (isSyllableTTML(cached)) {
      return { lyric: cached, awlyric: cached };
    } else {
      // 缓存的是普通逐行歌词
      if (acceptLineLyrics) {
        return { lyric: cached, awlyric: cached };
      }
      // 当前未接受逐行歌词时打破旧缓存，以便重新发起自愈探测尝试获取同录音逐字版本
      await splayer.storage.remove(cacheKey);
    }
  }

  // 仅请求逐字歌词接口；不请求/降级到纯逐行的 /lyrics 接口
  const suffix = buildLyricQuery(lang, script);
  const base = `/catalog/${accountStorefront}/songs/${songId}`;
  const resp = await ampRequestWithRetry(`${base}/syllable-lyrics${suffix}`, mediaUserToken);
  if (resp.status === 403) {
    throw new Error("Media-User-Token 无效或已过期，请在插件设置里重新填写");
  }
  if (resp.status !== 200) {
    splayer.log.warn(`歌词请求失败 HTTP ${resp.status} id=${songId} sf=${accountStorefront}`);
    if (resp.status === 404) {
      await cacheLyric(cacheKey, NO_LYRIC_MARKER);
    }
    return { lyric: "" };
  }

  const attrs = resp.body?.data?.[0]?.attributes;
  if (!attrs) {
    await cacheLyric(cacheKey, NO_LYRIC_MARKER);
    return { lyric: "" };
  }

  let ttml = pickTTML(resp.body);
  if (!ttml || !ttml.trim()) {
    await cacheLyric(cacheKey, NO_LYRIC_MARKER);
    return { lyric: "" };
  }

  // 预处理：将 Apple Music 简体替换段 (translation type="replacement") 融合进主歌词
  ttml = applyReplacementTranslations(ttml);

  // 判定是否为普通逐行歌词（displayType 为 2 或内容无逐字 span 时间戳）
  let isLineLyric =
    attrs.displayType === 2 || String(attrs.displayType) === "2" || !isSyllableTTML(ttml);

  // 核心自愈升级：若当前版本仅为普通逐行歌词，且具备 ISRC，自动探测同录音孪生版本（如 Single 单曲版）以获取逐字歌词！
  const isrc = musicInfo.isrc || attrs.isrc;
  if (isLineLyric && isrc) {
    try {
      const isrcPath = `/catalog/${accountStorefront}/songs?filter%5Bisrc%5D=${encodeURIComponent(isrc)}`;
      const isrcResp = await ampRequestWithRetry(isrcPath, mediaUserToken, 3500);
      if (isrcResp.status === 200) {
        const twinSongs = (isrcResp.body?.data ?? []).filter((item) => String(item.id) !== songId);
        // 优先探测标记为 Single/单曲 的版本，次选同录音其他版本
        twinSongs.sort((a, b) => {
          const aName = (a.attributes?.albumName ?? "") + (a.attributes?.name ?? "");
          const bName = (b.attributes?.albumName ?? "") + (b.attributes?.name ?? "");
          const aSingle = /single|单曲|ep/i.test(aName);
          const bSingle = /single|单曲|ep/i.test(bName);
          if (aSingle !== bSingle) return aSingle ? -1 : 1;
          return 0;
        });

        for (const twin of twinSongs) {
          const twinId = String(twin.id);
          const twinResp = await ampRequestWithRetry(
            `/catalog/${accountStorefront}/songs/${twinId}/syllable-lyrics${suffix}`,
            mediaUserToken,
            3500,
          );
          if (twinResp.status === 200) {
            let twinTtml = pickTTML(twinResp.body);
            if (twinTtml && twinTtml.trim()) {
              twinTtml = applyReplacementTranslations(twinTtml);
              if (isSyllableTTML(twinTtml)) {
                splayer.log.info(
                  `成功从孪生版本 id=${twinId} (${twin.attributes?.albumName}) 获取到逐字歌词，自愈替换原逐行版本 id=${songId}`,
                );
                ttml = twinTtml;
                isLineLyric = false;
                break;
              }
            }
          }
        }
      }
    } catch (err) {
      splayer.log.warn(`孪生录音自愈探测失败 isrc=${isrc}`, err?.message);
    }
  }

  if (isLineLyric) {
    if (!acceptLineLyrics) {
      splayer.log.info(
        `歌词为逐行类型 (displayType=${attrs.displayType})，丢弃不传给宿主 id=${songId}`,
      );
      await cacheLyric(cacheKey, ttml);
      return { lyric: "" };
    }
    splayer.log.info(
      `歌词为逐行类型 (displayType=${attrs.displayType})，根据设置放行传给宿主 id=${songId}`,
    );
  }

  await cacheLyric(cacheKey, ttml);
  // lyric 非空是宿主采纳的门槛，awlyric 让宿主走逐字解析
  return { lyric: ttml, awlyric: ttml };
});

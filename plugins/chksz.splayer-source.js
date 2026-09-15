/**
 * @name        ChKSz 音源
 * @id          chksz.splayer-source
 * @version     0.8.0
 * @description 为 SPlayer-Next 解析网易云 / QQ 音乐 / 酷狗音源：超清母带、Hi-Res、无损，无版权歌曲自动跨平台兜底
 * @author      HSJ-BanFan
 * @homepage    https://github.com/HSJ-BanFan/splayer-chksz-plugin
 * @type        source
 * @grant       network
 * @apiLevel    2
 * @updateUrl   https://raw.githubusercontent.com/HSJ-BanFan/splayer-chksz-plugin/main/dist/chksz.splayer-source.js
 * @changelog   按来源读取平台 ID；上游故障时支持跨平台搜索与解析
 */

const API_BASE_URL = "https://api.chksz.com";
const API_KEY_SETTING = "apiKey";
const REQUEST_TIMEOUT = 20_000;

const CROSS_PLATFORM_SETTING = "crossPlatformFallback";
const DURATION_TOLERANCE_SECONDS = 20;
const SEARCH_RESULT_LIMIT = 10;
const CROSS_PLATFORM_MAX_CANDIDATES = 3;
const CROSS_PLATFORM_REQUEST_BUDGET = 8;
const CROSS_PLATFORM_TIME_BUDGET = 10_000;
const CROSS_PLATFORM_LIMIT_ERROR = "CHKSZ_CROSS_PLATFORM_LIMIT";
const CROSS_PLATFORM_UNAVAILABLE_ERROR = "CHKSZ_CROSS_PLATFORM_UNAVAILABLE";
const CHANNEL_COOLDOWN_ERROR = "CHKSZ_CHANNEL_COOLDOWN";
const RATE_LIMIT_ERROR = "CHKSZ_RATE_LIMITED";
const RESOLUTION_TIME_BUDGET = 18_000;
const RESOLUTION_TIMEOUT_ERROR = "CHKSZ_RESOLUTION_TIMEOUT";
const REQUEST_TIMEOUT_ERROR = "CHKSZ_REQUEST_TIMEOUT";
const NETWORK_ERROR = "CHKSZ_NETWORK_ERROR";
const CACHE_LIMIT = 128;
const CACHE_TTL = 5 * 60_000;
const UNAVAILABLE_TTL = 60_000;
const URL_EXPIRY_MARGIN = 30_000;
// ChKSz 限流为 20 RPM；命中 429 后按 Retry-After 进入冷却，避免把额度继续打空。
const RATE_LIMIT_COOLDOWN = 60_000;
const MAX_RATE_LIMIT_COOLDOWN = 15 * 60_000;
// 502/503/504 是 ChKSz 上游故障（实测酷狗会持续返回并触发服务端熔断），冷却期内不再探测该平台。
const CHANNEL_COOLDOWN = 2 * 60_000;
// 通道冷却优先按服务端 Retry-After，但不超过这个上限。
const MAX_CHANNEL_COOLDOWN = 15 * 60_000;
// 同一平台的 ChKSz 搜索对多个不同关键词连续 404，说明是搜索通道故障而不是"没这首歌"。
const SEARCH_OUTAGE_THRESHOLD = 3;
// 酷狗对过长的 msg 返回 400；关键词统一截断。
const SEARCH_KEYWORD_MAX_LENGTH = 60;
// ChKSz 的 QQ 音乐搜索通道曾对任何关键词都返回 404（2026-09-11 起持续数日），而按 mid 解析正常。
// 此时改用 QQ 音乐公开搜索拿 mid，再交给 ChKSz 解析；公开搜索不消耗 ChKSz 额度。
const DIRECT_SEARCH_SETTING = "directSearchFallback";
const DIRECT_SEARCH_ERROR = "CHKSZ_DIRECT_SEARCH_FAILED";
const QQ_PUBLIC_SEARCH_URL = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const DIRECT_SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// 整条音质阶梯都不可用说明是版权问题而非瞬时抖动，短期内同曲直接跳跨平台，省下阶梯请求。
const TRACK_UNAVAILABLE_TTL = CACHE_TTL;
// 交付体检：返回地址前只取前几个字节确认真的能拉流（CDN 请求，不消耗 ChKSz 额度）。
const DELIVERY_UNUSABLE_ERROR = "CHKSZ_DELIVERY_UNUSABLE";
const PROBE_TIMEOUT = 4_000;
const PROBE_RANGE = "bytes=0-3";
// 只有这些错误才说明"地址打不开"；宿主不支持体检选项等其它错误按无法判定处理，不降级。
const UNREACHABLE_PROBE_CODES = new Set([
  REQUEST_TIMEOUT_ERROR,
  "PLUGIN_REQUEST_TIMEOUT",
  "PLUGIN_NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
]);

const QUALITY_NAMES = ["lq", "sq", "hq", "lossless", "hi-res"];
// 母带/音效档：实测网易云这些档位交付 192kHz/24-bit FLAC，单曲 46–150MB（一首 153 秒
// 的歌 103MB），部分播放器无法起播。"可播放优先"把它们排到阶梯最后。
const MASTER_TIER_LEVELS = new Set(["jymaster", "jyeffect", "sky"]);
// ChKSz 原生档位 → SPlayer 逻辑音质。多对一是不可避免的：hq/sq 共用一个原生档位，
// hi-res 对应 jymaster/hires/sky/jyeffect 四个不同的事实，所以只用于"实际交付了什么"。
const NATIVE_QUALITY_LEVELS = {
  standard: "lq",
  "128k": "lq",
  exhigh: "hq",
  "320k": "hq",
  lossless: "lossless",
  flac: "lossless",
  hires: "hi-res",
  master: "hi-res",
  jymaster: "hi-res",
  sky: "hi-res",
  jyeffect: "hi-res",
};
// Logical downgrade ladder shared by every provider: hi-res → lossless → hq → sq → lq.
const QUALITY_FALLBACKS = Object.fromEntries(
  QUALITY_NAMES.map((quality, index) => [
    quality,
    QUALITY_NAMES.slice(0, index + 1).reverse(),
  ]),
);

const SOURCE_POLICIES = {
  wy: {
    name: "ChKSz 网易云",
    identity: { idParameter: "id", idFields: ["id", "songId", "songmid"] },
    playback: {
      endpoint: "/api/163_music",
      qualityParameter: "level",
      qualityValues: {
        "hi-res": "jymaster",
        lossless: "lossless",
        hq: "exhigh",
        sq: "exhigh",
        lq: "standard",
      },
      qualityAlternatives: { "hi-res": ["hires"] },
      qualityFallbacks: QUALITY_FALLBACKS,
    },
    search: {
      endpoint: "/api/163_search",
      keywordParameter: "keyword",
      params: { limit: SEARCH_RESULT_LIMIT },
      candidateIdField: "id",
    },
    // NetEase lacks the rights to many catalogues; look the same song up elsewhere.
    crossPlatform: { sources: ["tx", "kg"] },
    actions: {
      musicLyric: { endpoint: "/api/163_lyric", params: {} },
      musicPic: {
        endpoint: "/api/163_music",
        params: { level: "standard", type: "json" },
      },
    },
  },
  tx: {
    name: "ChKSz QQ 音乐",
    identity: { idParameter: "mid", idFields: ["songmid", "mid", "id", "songId"] },
    playback: {
      endpoint: "/api/qq_music",
      qualityParameter: "size",
      qualityValues: {
        "hi-res": "master",
        lossless: "flac",
        hq: "320k",
        sq: "320k",
        lq: "128k",
      },
      qualityAlternatives: { "hi-res": ["hires"] },
      qualityFallbacks: QUALITY_FALLBACKS,
    },
    search: {
      endpoint: "/api/qq_music",
      keywordParameter: "msg",
      params: { num: SEARCH_RESULT_LIMIT },
      candidateIdField: "mid",
    },
    crossPlatform: { sources: ["wy", "kg"] },
    // ChKSz 搜索不可用时的备用搜索：QQ 音乐公开接口，结果映射成与 ChKSz 搜索相同的候选字段。
    directSearch: {
      name: "QQ 音乐公开搜索",
      endpoint: QQ_PUBLIC_SEARCH_URL,
      params: (keyword) => ({
        format: "json",
        p: 1,
        n: SEARCH_RESULT_LIMIT,
        w: keyword,
        cr: 1,
        g_tk: 5381,
        t: 0,
      }),
      headers: { Referer: "https://y.qq.com/", "User-Agent": DIRECT_SEARCH_USER_AGENT },
      candidates: (body) => {
        const list = body?.data?.song?.list;
        if (!Array.isArray(list)) return [];
        return list
          .map((item) => ({
            name: textOrEmpty(item?.songname),
            singer: (Array.isArray(item?.singer) ? item.singer : [])
              .map((artist) => textOrEmpty(artist?.name))
              .filter(Boolean)
              .join("/"),
            album: textOrEmpty(item?.albumname),
            interval: Number(item?.interval) || undefined,
            mid: textOrEmpty(item?.songmid),
          }))
          .filter((item) => item.mid && item.name);
      },
    },
    actions: {
      musicLyric: { request: "trackDetails" },
      musicPic: { request: "trackDetails" },
    },
  },
  kg: {
    name: "ChKSz 酷狗",
    identity: { idParameter: "id", idFields: ["hash", "id", "songId"] },
    playback: {
      endpoint: "/api/kugou_music",
      qualityParameter: "size",
      qualityValues: {
        "hi-res": "master",
        lossless: "flac",
        hq: "320k",
        sq: "320k",
        lq: "128k",
      },
      qualityAlternatives: { "hi-res": ["hires"] },
      qualityFallbacks: QUALITY_FALLBACKS,
    },
    search: {
      endpoint: "/api/kugou_music",
      keywordParameter: "msg",
      params: {},
      candidateIdField: "id",
    },
    crossPlatform: { sources: ["tx", "wy"] },
    actions: {
      musicLyric: { request: "trackDetails" },
      musicPic: { request: "trackDetails" },
    },
  },
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const pluginError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const getMusicId = (source, musicInfo) => {
  if (!isRecord(musicInfo)) {
    throw pluginError("CHKSZ_TRACK_INVALID", "SPlayer 未提供有效的歌曲信息。");
  }

  const fields = getSourcePolicy(source).identity.idFields ?? [];
  for (const key of fields) {
    const value = musicInfo[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }

  throw pluginError("CHKSZ_TRACK_INVALID", "歌曲缺少平台 ID，无法请求 ChKSz。");
};

const textOrEmpty = (value) => (typeof value === "string" ? value.trim() : "");

const ARTIST_SEPARATOR = /[/、,，&]/;
const TITLE_BRACKET_PATTERN = /[（(\[【][^）)\]】]{0,40}[）)\]】]/g;
const TITLE_TRAILING_VARIANT_PATTERN =
  /[\s\-–—_]+(?:live|remaster(?:ed)?|version|ver\.?|instrumental|inst\.?|off\s*vocal|伴奏|现场|演唱会).*$/i;

/**
 * 去掉标题里的版本标记（括号段、"- Live" 这类后缀）。
 * 用于跨平台搜索关键词，以及"原曲自带版本标记、候选是干净标题"时的宽松匹配。
 */
const stripTitleVariant = (value) => {
  const original = textOrEmpty(value);
  const stripped = original
    .replace(TITLE_BRACKET_PATTERN, " ")
    .replace(TITLE_TRAILING_VARIANT_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
  // 整个标题都是版本标记时（例如 "(Live)"）退回原值，避免把所有候选都视为同一首。
  return stripped || original;
};

/** Metadata SPlayer attaches to musicInfo; only used for cross-platform matching. */
const getTrackDescriptor = (musicInfo) => ({
  name: textOrEmpty(musicInfo?.name),
  singer: textOrEmpty(musicInfo?.singer),
  interval: textOrEmpty(musicInfo?.interval),
});

const getSourcePolicy = (source) => {
  const policy = SOURCE_POLICIES[source];
  if (!policy) {
    throw pluginError(
      "CHKSZ_SOURCE_UNSUPPORTED",
      `不支持的 SPlayer 音源：${String(source)}。`,
    );
  }
  return policy;
};

const buildTrackParams = (source, id, quality, nativeQualityOverride) => {
  const policy = getSourcePolicy(source);
  const requestedQuality = QUALITY_NAMES.includes(quality) ? quality : "hq";
  return {
    policy,
    requestedQuality,
    params: {
      [policy.identity.idParameter]: id,
      [policy.playback.qualityParameter]:
        nativeQualityOverride ?? policy.playback.qualityValues[requestedQuality],
      type: "json",
    },
  };
};

const createResolutionCore = () => {
  let session;
  const enabledSetting = (key, fallback) => {
    const value = splayer.getSetting(key);
    return value === undefined || value === null || value === "" ? fallback : value === true;
  };

  // A new account/configuration owns new maps. In-flight old work cannot fill them.
  const getSession = () => {
    const apiKey = getApiKey();
    const config = {
      smartCache: enabledSetting("smartCache", true),
      economyMode: enabledSetting("economyMode", false),
      metadataFallback: enabledSetting("metadataFallback", true),
      crossPlatformFallback: enabledSetting(CROSS_PLATFORM_SETTING, true),
      directSearchFallback: enabledSetting(DIRECT_SEARCH_SETTING, true),
      playableFirst: enabledSetting("playableFirst", false),
      verifyDelivery: enabledSetting("verifyDelivery", true),
    };
    const signature = JSON.stringify([apiKey, config]);
    if (session?.signature !== signature) {
      session = {
        apiKey, config, signature,
        responses: new Map(), metadata: new Map(), actions: new Map(),
        pending: new Map(), actionPending: new Map(),
        channelCooldowns: new Map(), unavailableTracks: new Map(), probes: new Map(),
        searchFailures: new Map(), searchCooldowns: new Map(),
        rateLimitUntil: 0,
      };
    }
    return session;
  };

  const readCache = (map, key) => {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.until <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return entry.value;
  };

  const writeCache = (map, key, value, until) => {
    if (until <= Date.now()) return;
    map.delete(key);
    while (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value);
    map.set(key, { value, until });
  };

  const sharePending = async (state, map, key, operation) => {
    if (!state.config.smartCache) return operation();
    const existing = map.get(key);
    if (existing) return existing;
    if (map.size >= CACHE_LIMIT) return operation();
    const pending = Promise.resolve().then(operation);
    map.set(key, pending);
    try {
      return await pending;
    } finally {
      if (map.get(key) === pending) map.delete(key);
    }
  };

  const remainingSeconds = (until) =>
    Math.max(0, Math.ceil((Number(until) - Date.now()) / 1000));

  const assertRateLimit = (state) => {
    const remaining = remainingSeconds(state.rateLimitUntil);
    if (remaining > 0) {
      throw pluginError(
        RATE_LIMIT_ERROR,
        `ChKSz 请求受限：请在 ${remaining} 秒后再试。`,
      );
    }
  };

  const noteRateLimit = (state, error) => {
    if (Number(error?.status) !== 429) return;
    const retryAfter = Number(error?.retryAfterSeconds);
    const seconds =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : RATE_LIMIT_COOLDOWN / 1000;
    const until = Date.now() + Math.min(seconds * 1000, MAX_RATE_LIMIT_COOLDOWN);
    state.rateLimitUntil = Math.max(state.rateLimitUntil, until);
  };

  // 502/503/504 由 ChKSz 的上游选曲通道返回；此时继续探测只会白打请求。
  const isUpstreamUnavailableError = (error) =>
    [502, 503, 504].includes(Number(error?.status));

  const coolingDown = (map, source) => {
    const until = map.get(source);
    if (!until) return 0;
    const remaining = remainingSeconds(until);
    if (remaining <= 0) {
      map.delete(source);
      return 0;
    }
    return remaining;
  };

  const coolingDownChannel = (state, source) => coolingDown(state.channelCooldowns, source);

  const canDirectSearch = (state, source) =>
    Boolean(getSourcePolicy(source).directSearch) && Boolean(state?.config.directSearchFallback);

  // 平台级冷却：上游 502/503/504；或者 ChKSz 搜索通道故障且没有备用搜索可用。
  const coolingDownPlatform = (state, source) =>
    coolingDownChannel(state, source) ||
    (canDirectSearch(state, source) ? 0 : coolingDown(state.searchCooldowns, source));

  const cooldownMillis = (error, fallback) => {
    const retryAfter = Number(error?.retryAfterSeconds);
    return Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, MAX_CHANNEL_COOLDOWN)
      : fallback;
  };

  const noteChannelFailure = (state, source, error) => {
    if (!isUpstreamUnavailableError(error)) return;
    state.channelCooldowns.set(source, Date.now() + cooldownMillis(error, CHANNEL_COOLDOWN));
  };

  // 搜索接口的 404 表示"没搜到"；对多个不同关键词都 404 才判为通道故障。
  const isSearchNotFoundError = (error) =>
    error?.code === "CHKSZ_HTTP_404" && !isUnavailableQualityError(error);

  const noteSearchOutcome = (state, source, keyword, error) => {
    if (!error) {
      state.searchFailures.delete(source);
      return;
    }
    if (!isSearchNotFoundError(error)) return;
    const keywords = state.searchFailures.get(source) ?? new Set();
    keywords.add(keyword);
    state.searchFailures.set(source, keywords);
    if (keywords.size >= SEARCH_OUTAGE_THRESHOLD) {
      state.searchFailures.delete(source);
      state.searchCooldowns.set(source, Date.now() + CHANNEL_COOLDOWN);
    }
  };

  const trackUnavailableKey = (source, id) => `${source}:${String(id)}`;

  const readUnavailableTrack = (state, source, id) => {
    const key = trackUnavailableKey(source, id);
    const entry = state.unavailableTracks.get(key);
    if (!entry) return undefined;
    if (entry.until <= Date.now()) {
      state.unavailableTracks.delete(key);
      return undefined;
    }
    return entry.error;
  };

  const rememberUnavailableTrack = (state, source, id, error) => {
    if (!state.config.smartCache) return;
    const key = trackUnavailableKey(source, id);
    state.unavailableTracks.delete(key);
    while (state.unavailableTracks.size >= CACHE_LIMIT) {
      state.unavailableTracks.delete(state.unavailableTracks.keys().next().value);
    }
    state.unavailableTracks.set(key, {
      error,
      until: Date.now() + TRACK_UNAVAILABLE_TTL,
    });
  };

  const getApiKey = () => {
    const value = splayer.getSetting(API_KEY_SETTING);
    const apiKey = typeof value === "string" ? value.trim() : "";

    if (!apiKey) {
      throw pluginError(
        "CHKSZ_CONFIG_MISSING",
        "未配置 ChKSz API Key：请打开 设置 → 插件管理 → ChKSz 音源 → 配置。",
      );
    }

    // RFC 3986 unreserved characters; this prevents accidentally sending whitespace or a URL.
    if (!/^chksz_[A-Za-z0-9._~-]+$/.test(apiKey)) {
      throw pluginError(
        "CHKSZ_CONFIG_INVALID",
        "ChKSz API Key 格式无效：Key 应以 chksz_ 开头，并只包含 URL 安全字符。",
      );
    }

    return apiKey;
  };

  const buildApiUrl = (endpoint, params, apiKey) => {
    const url = new URL(`${API_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries({
      ...params,
      apikey: apiKey,
    })) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  };

  const getBodyMessage = (body) => {
    if (!isRecord(body)) return "";
    for (const key of ["msg", "message", "error"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (
        isRecord(value) &&
        typeof value.message === "string" &&
        value.message.trim()
      ) {
        return value.message.trim();
      }
    }
    return "";
  };

  const redactSensitiveData = (value) =>
    String(value ?? "")
      .replace(/([?&]apikey=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/chksz_[A-Za-z0-9._~-]+/gi, "chksz_[REDACTED]");

  const getHeader = (headers, name) => {
    if (!isRecord(headers)) return "";
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted && typeof value === "string")
        return value;
    }
    return "";
  };

  const throwHttpError = (response) => {
    const status = Number(response?.status) || 0;
    const bodyMessage = redactSensitiveData(getBodyMessage(response?.body));
    const parts = [`ChKSz 请求失败（HTTP ${status}）`];
    if (bodyMessage) parts.push(bodyMessage);

    const retryAfter = getHeader(response?.headers, "retry-after");
    if (retryAfter && status === 429) {
      parts.push(`请在 ${redactSensitiveData(retryAfter)} 秒后再试`);
    }
    // 额度类错误把响应头里的剩余额度写进文案，用户一眼知道是免费还是付费额度用完。
    if (status === 402 || status === 429) {
      const free = getHeader(response?.headers, "x-quota-free-remaining");
      const paid = getHeader(response?.headers, "x-quota-paid-remaining");
      if (free !== "" || paid !== "") {
        parts.push(
          `免费额度剩余 ${redactSensitiveData(free || "?")}，付费额度剩余 ${redactSensitiveData(paid || "?")}`,
        );
      }
    }

    const code = status > 0 ? `CHKSZ_HTTP_${status}` : "CHKSZ_HTTP_ERROR";
    const error = pluginError(code, parts.join("："));
    // 结构化状态供限流/通道冷却判定，避免从文案反推。Retry-After 对 429 和 5xx 都记录。
    error.status = status;
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      error.retryAfterSeconds = retryAfterSeconds;
    }
    throw error;
  };

  const throwApiError = (body) => {
    const apiCode = Number(body?.code);
    if (!Number.isInteger(apiCode) || apiCode === 200) return;

    const bodyMessage = redactSensitiveData(getBodyMessage(body));
    const isHttpStatus = apiCode >= 400 && apiCode <= 599;
    const prefix = isHttpStatus
      ? `ChKSz 请求失败（HTTP ${apiCode}）`
      : `ChKSz 返回错误码 ${apiCode}`;
    const code = isHttpStatus ? `CHKSZ_HTTP_${apiCode}` : `CHKSZ_API_${apiCode}`;
    const error = pluginError(code, bodyMessage ? `${prefix}：${bodyMessage}` : prefix);
    error.status = apiCode;
    throw error;
  };

  const isUnavailableQualityError = (error) =>
    error?.code === "CHKSZ_HTTP_404" &&
    /music url not found\s*,\s*song may be unavailable at this quality level/i.test(
      error.message || "",
    );

  // Key, quota, ban and rate-limit failures affect every request; stop probing after them.
  const isAccountError = (error) =>
    /^CHKSZ_(CONFIG_|RATE_LIMITED$|HTTP_(401|402|403|429)$)/.test(String(error?.code));

  const isCrossPlatformLimitError = (error) =>
    error?.code === CROSS_PLATFORM_LIMIT_ERROR;

  const isResolutionTimeoutError = (error) =>
    error?.code === RESOLUTION_TIMEOUT_ERROR;

  const isRequestTimeoutError = (error) =>
    error?.code === REQUEST_TIMEOUT_ERROR;

  const isHostRequestTimeoutError = (error) =>
    ["PLUGIN_REQUEST_TIMEOUT", "REQUEST_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(
      String(error?.code),
    ) || error?.name === "TimeoutError";

  const isHostCancellationError = (error) =>
    ["PLUGIN_CANCELLED", "PLUGIN_ABORTED", "ABORT_ERR", "ERR_ABORTED"].includes(
      String(error?.code),
    ) || error?.name === "AbortError";

  const isOperationalError = (error) =>
    error?.code === NETWORK_ERROR || isRequestTimeoutError(error);

  const isProviderError = (error) =>
    /^CHKSZ_(HTTP(?:_\d{3}|_ERROR)|API_|INVALID_RESPONSE)/.test(
      String(error?.code),
    );

  const requestWithTimeout = async (
    url,
    options,
    timeoutCode = REQUEST_TIMEOUT_ERROR,
  ) => {
    const timeout = Number(options?.timeout) > 0 ? Number(options.timeout) : REQUEST_TIMEOUT;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => splayer.request(url, options)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              pluginError(
                timeoutCode,
                timeoutCode === RESOLUTION_TIMEOUT_ERROR
                  ? "SPlayer 播放地址解析已达到时间上限。"
                  : timeoutCode === CROSS_PLATFORM_LIMIT_ERROR
                    ? "ChKSz 跨平台兜底已达到请求或时间上限。"
                    : `ChKSz 请求超过 ${timeout} 毫秒。`,
              ),
            );
          }, timeout);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const performRequestJson = async (endpoint, params, { budget, deadline, state }) => {
    let timeout = REQUEST_TIMEOUT;
    let timeoutCode = REQUEST_TIMEOUT_ERROR;
    const remainingResolutionTime = Number.isFinite(deadline)
      ? deadline - Date.now()
      : Infinity;
    if (remainingResolutionTime <= 0) {
      throw pluginError(
        RESOLUTION_TIMEOUT_ERROR,
        "SPlayer 播放地址解析已达到时间上限。",
      );
    }

    if (budget) {
      const remainingTime = budget.deadline - Date.now();
      if (budget.remaining <= 0 || remainingTime <= 0) {
        throw pluginError(
          CROSS_PLATFORM_LIMIT_ERROR,
          "ChKSz 跨平台兜底已达到请求或时间上限。",
        );
      }
      budget.remaining -= 1;
      timeout = Math.max(1, Math.min(REQUEST_TIMEOUT, remainingTime));
      timeoutCode = CROSS_PLATFORM_LIMIT_ERROR;
    }
    if (Number.isFinite(remainingResolutionTime)) {
      if (remainingResolutionTime < timeout) {
        timeoutCode = RESOLUTION_TIMEOUT_ERROR;
      }
      timeout = Math.max(1, Math.min(timeout, remainingResolutionTime));
    }

    const requestUrl = buildApiUrl(endpoint, params, state.apiKey);
    const requestOptions = {
      method: "GET",
      responseType: "json",
      timeout,
    };
    let response;
    try {
      response = await requestWithTimeout(requestUrl, requestOptions, timeoutCode);
    } catch (error) {
      if (isHostCancellationError(error)) {
        const code =
          typeof error?.code === "string" && error.code
            ? error.code
            : "PLUGIN_CANCELLED";
        throw pluginError(
          code,
          redactSensitiveData(error?.message ?? "SPlayer 已取消请求。"),
        );
      }
      if (
        isRequestTimeoutError(error) ||
        isResolutionTimeoutError(error) ||
        isCrossPlatformLimitError(error)
      ) {
        throw error;
      }
      if (isHostRequestTimeoutError(error)) {
        const hostTimeoutCode =
          timeoutCode === RESOLUTION_TIMEOUT_ERROR &&
          Number.isFinite(deadline) &&
          Date.now() >= deadline
            ? RESOLUTION_TIMEOUT_ERROR
            : timeoutCode === CROSS_PLATFORM_LIMIT_ERROR &&
                budget &&
                Date.now() >= budget.deadline
              ? CROSS_PLATFORM_LIMIT_ERROR
              : REQUEST_TIMEOUT_ERROR;
        throw pluginError(
          hostTimeoutCode,
          hostTimeoutCode === RESOLUTION_TIMEOUT_ERROR
            ? "SPlayer 播放地址解析已达到时间上限。"
            : hostTimeoutCode === CROSS_PLATFORM_LIMIT_ERROR
              ? "ChKSz 跨平台兜底已达到请求或时间上限。"
              : `ChKSz 请求超过 ${timeout} 毫秒。`,
        );
      }
      throw pluginError(
        NETWORK_ERROR,
        `ChKSz 网络请求失败：${redactSensitiveData(error?.message ?? error)}`,
      );
    }

    if (
      !response ||
      Number(response.status) < 200 ||
      Number(response.status) >= 300
    ) {
      throwHttpError(response);
    }

    if (!isRecord(response.body)) {
      throw pluginError(
        "CHKSZ_INVALID_RESPONSE",
        "ChKSz 返回的不是有效 JSON 对象。",
      );
    }

    throwApiError(response.body);
    return response.body;
  };

  const requestKey = (endpoint, params) => JSON.stringify([
    endpoint, Object.entries(params).sort(([left], [right]) => left.localeCompare(right)),
  ]);

  const assertCurrentSession = (state) => {
    if (state !== getSession()) {
      throw pluginError("CHKSZ_CONFIG_CHANGED", "ChKSz 配置已变化，请重新播放。");
    }
  };

  const isTierUnavailable = (error) =>
    isUnavailableQualityError(error) || error?.code === DELIVERY_UNUSABLE_ERROR;

  /**
   * 返回地址前的交付体检：只取前几个字节确认地址真的能拉流。
   * SPlayer 在播放失败时只会换音源、不会降音质，所以"这个地址能不能播"必须由插件自己兜。
   * @returns 不可用原因；可以放行时返回空串
   */
  const probeDelivery = async (url, state, deadline) => {
    const cached = readCache(state.probes, url);
    if (cached !== undefined) return cached;
    const remaining = Number.isFinite(deadline) ? deadline - Date.now() : Infinity;
    // 时间预算已经用尽时不再体检，交给调用方按原结果返回。
    if (remaining <= 0) return "";

    let response;
    try {
      response = await requestWithTimeout(url, {
        method: "GET",
        headers: { Range: PROBE_RANGE },
        responseType: "arraybuffer",
        timeout: Math.max(1, Math.min(PROBE_TIMEOUT, remaining)),
      });
    } catch (error) {
      if (!UNREACHABLE_PROBE_CODES.has(String(error?.code))) {
        // 老版本宿主可能不支持自定义头或 arraybuffer；无法判定时按可用处理，绝不因此降级。
        splayer.log.debug(
          `ChKSz 交付体检无法判定，按可用处理：${redactSensitiveData(error?.message ?? error)}`,
        );
        return "";
      }
      const reason = `地址打不开（${redactSensitiveData(error?.message ?? error)}）`;
      writeCache(state.probes, url, reason, Date.now() + CACHE_TTL);
      return reason;
    }

    const status = Number(response?.status) || 0;
    if (status < 200 || status >= 300) {
      const reason = `地址返回 HTTP ${status}`;
      writeCache(state.probes, url, reason, Date.now() + CACHE_TTL);
      return reason;
    }

    writeCache(state.probes, url, "", Date.now() + CACHE_TTL);
    return "";
  };

  const hasActionMetadata = (body, action) => {
    const fields = action === "musicLyric"
      ? ["lyric", "lrc", "awlyric", "yrc", "qrc", "krc"]
      : ["cover", "coverUrl", "pic", "picUrl", "albumCover"];
    const text = extractTextField(body, fields);
    return Boolean(text) && (action === "musicLyric" || /^https?:\/\//i.test(text));
  };

  const requestJson = async (endpoint, params, context = {}) => {
    const state = context.state ?? getSession();
    assertCurrentSession(state);
    // Cache hits do not spend a request budget, but must respect the total deadline.
    if (Number.isFinite(context.deadline) && Date.now() >= context.deadline) {
      throw pluginError(RESOLUTION_TIMEOUT_ERROR, "SPlayer 播放地址解析已达到时间上限。");
    }
    if (context.budget && Date.now() >= context.budget.deadline) {
      throw pluginError(CROSS_PLATFORM_LIMIT_ERROR, "ChKSz 跨平台兜底已达到请求或时间上限。");
    }
    const key = requestKey(endpoint, params);
    const cached = state.config.smartCache && readCache(state.responses, key);
    if (cached && (cached.error || !context.action || hasActionMetadata(cached.body, context.action))) {
      splayer.log.debug(`ChKSz 复用缓存：${endpoint}`);
      if (cached.error) throw cached.error;
      return cached.body;
    }
    let body;
    try {
      // 缓存命中不算请求，因此限流闸门放在缓存之后、真正发请求之前。
      assertRateLimit(state);
      body = await performRequestJson(endpoint, params, { ...context, state });
    } catch (error) {
      noteRateLimit(state, error);
      if (state.config.smartCache && isUnavailableQualityError(error)) {
        writeCache(state.responses, key, { error }, Date.now() + UNAVAILABLE_TTL);
      }
      throw error;
    }
    assertCurrentSession(state);
    if (state.config.smartCache) {
      if (params.msg || params.keyword) {
        const hasSearchShape = [body, body?.data, body?.result].some(
          (value) => Array.isArray(value) || Array.isArray(value?.list),
        );
        if (hasSearchShape) {
          const ttl = extractCandidates(body).length ? CACHE_TTL : UNAVAILABLE_TTL;
          writeCache(state.responses, key, { body }, Date.now() + ttl);
        }
      } else {
        const expiry = extractExpiry(body);
        if (extractUrl(body) && expiry) {
          writeCache(state.responses, key, { body }, Math.min(expiry - URL_EXPIRY_MARGIN, Date.now() + CACHE_TTL));
        }
        for (const [source, policy] of Object.entries(SOURCE_POLICIES)) {
          if (policy.playback.endpoint === endpoint && params[policy.identity.idParameter] != null) {
            writeCache(state.metadata, JSON.stringify([source, String(params[policy.identity.idParameter])]), body, Date.now() + CACHE_TTL);
          }
        }
      }
    }
    return body;
  };

  const extractUrl = (body) => {
    const candidates = [
      body?.url,
      body?.data?.url,
      body?.result?.url,
      typeof body?.data === "string" ? body.data : undefined,
      typeof body?.result === "string" ? body.result : undefined,
    ];

    const url = candidates.find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (!url) return "";

    const trimmed = url.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : "";
  };

  const normaliseExpiry = (value) => {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || number <= 0) return undefined;
    const expiry = number < 1_000_000_000_000 ? number * 1000 : number;
    return expiry > Date.now() ? expiry : undefined;
  };

  const extractExpiry = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (!isRecord(container)) continue;
      for (const key of ["expire", "expiresAt", "expires_at", "urlExpire"]) {
        const expiry = normaliseExpiry(container[key]);
        if (expiry) return expiry;
      }
    }
    return undefined;
  };

  /**
   * 服务端会用响应体里的 level/bitrate/format 说明实际交付的档位。
   * 实测请求 hires 时服务端会静默返回 lossless，因此不能拿请求档位当结果。
   */
  const readServedQuality = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (!isRecord(container)) continue;
      for (const key of ["level", "bitrate", "format"]) {
        const logical = NATIVE_QUALITY_LEVELS[textOrEmpty(container[key]).toLowerCase()];
        if (logical) return logical;
      }
    }
    return "";
  };

  const normalisePlaybackResponse = (body) => {
    const url = extractUrl(body);
    if (!url) {
      const message = redactSensitiveData(getBodyMessage(body));
      throw pluginError(
        "CHKSZ_NO_URL",
        message ? `ChKSz 未返回播放地址：${message}` : "ChKSz 未返回播放地址。",
      );
    }

    const result = { url };
    const expire = extractExpiry(body);
    if (expire) result.expire = expire;
    return result;
  };

  const selectQualityCandidates = (policy, requestedQuality, config = {}) => {
    const { economyMode = false, playableFirst = true } = config;
    const logicalQualities = economyMode ? [requestedQuality, "lq"] : policy.playback.qualityFallbacks?.[
      requestedQuality
    ] ?? [requestedQuality];
    const attemptedNativeQualities = new Set();
    const { qualityValues } = policy.playback;

    const candidates = logicalQualities
      .flatMap((candidateQuality) =>
        [
          qualityValues[candidateQuality],
          ...(economyMode ? [] : policy.playback.qualityAlternatives?.[candidateQuality] ?? []),
        ].map((nativeQuality) => ({ candidateQuality, nativeQuality })),
      )
      .filter(({ nativeQuality }) => {
        if (attemptedNativeQualities.has(nativeQuality)) return false;
        attemptedNativeQualities.add(nativeQuality);
        return true;
      });

    // 省配额模式本身就是用户显式选的取舍，不改它的顺序。
    if (!playableFirst || economyMode) return candidates;

    return [
      ...candidates.filter(({ nativeQuality }) => !MASTER_TIER_LEVELS.has(nativeQuality)),
      ...candidates.filter(({ nativeQuality }) => MASTER_TIER_LEVELS.has(nativeQuality)),
    ];
  };

  const resolveOnPlatform = async (source, quality, id, requestContext = {}) => {
    const { policy, requestedQuality } = buildTrackParams(source, id, quality);
    const state = requestContext.state;
    const remembered = state ? readUnavailableTrack(state, source, id) : undefined;
    if (remembered) throw remembered;

    const economyMode = state?.config.economyMode;
    const qualityCandidates = selectQualityCandidates(policy, requestedQuality, state?.config);
    let body;
    let resolvedQuality = requestedQuality;

    for (const [index, { candidateQuality, nativeQuality }] of qualityCandidates.entries()) {
      const { params } = buildTrackParams(source, id, candidateQuality, nativeQuality);

      try {
        body = await requestJson(policy.playback.endpoint, params, requestContext);
        if (state?.config.verifyDelivery) {
          const candidateUrl = extractUrl(body);
          if (candidateUrl) {
            const unusable = await probeDelivery(candidateUrl, state, requestContext.deadline);
            if (unusable) throw pluginError(DELIVERY_UNUSABLE_ERROR, unusable);
          }
        }
        resolvedQuality = candidateQuality;
        break;
      } catch (error) {
        const hasFallback = index < qualityCandidates.length - 1;
        // 完整阶梯全部不可用说明是版权问题，而非某一档抖动；省配额模式的阶梯不完整，不能据此下结论。
        if (!hasFallback && state && !economyMode && isUnavailableQualityError(error)) {
          rememberUnavailableTrack(state, source, id, error);
        }
        if (!hasFallback || !isTierUnavailable(error)) throw error;
      }
    }

    const result = normalisePlaybackResponse(body);
    // 上报服务端实际交付的档位；响应体没有档位字段时退回请求的逻辑档位。
    result.quality = readServedQuality(body) || resolvedQuality;
    return { result, body };
  };

  const normaliseText = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");

  const splitArtists = (value) =>
    String(value ?? "").split(ARTIST_SEPARATOR).map(normaliseText).filter(Boolean);

  const exactlyEqual = (a, b) => Boolean(a) && Boolean(b) && a === b;

  const parseDurationSeconds = (value) => {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value <= 0) return 0;
      // Values this large can only be milliseconds.
      return value >= 36_000 ? value / 1000 : value;
    }
    const text = textOrEmpty(value);
    const clock = /^(\d{1,3}):(\d{2})$/.exec(text);
    if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
    return parseDurationSeconds(Number(text));
  };

  /** 只有"原曲自带版本标记、候选是干净标题"时才允许宽松匹配。 */
  const isVariantFallback = (wantedTitle, candidateTitle) => {
    const wanted = textOrEmpty(wantedTitle);
    const candidate = textOrEmpty(candidateTitle);
    const wantedBase = stripTitleVariant(wanted);
    const candidateBase = stripTitleVariant(candidate);
    // 原曲本身没有版本标记，说明它就是规范版本，不接受别的版本顶替。
    if (normaliseText(wantedBase) === normaliseText(wanted)) return false;
    // 候选自己也带版本标记时必须走精确匹配，否则会拿另一个变体冒充。
    if (normaliseText(candidateBase) !== normaliseText(candidate)) return false;
    return exactlyEqual(normaliseText(wantedBase), normaliseText(candidateBase));
  };

  /** 0 = different song, 2 = exact normalised title, 1 = relaxed title match. */
  const matchScore = (
    track,
    candidate,
    { requireDuration = false, requireDurationForRelaxed = false } = {},
  ) => {
    if (!isRecord(candidate)) return 0;
    const wantedName = normaliseText(track.name);
    const candidateName = normaliseText(candidate.name);
    const exact = exactlyEqual(wantedName, candidateName);
    const relaxed = !exact && isVariantFallback(track.name, candidate.name);
    if (!exact && !relaxed) return 0;

    const wantedArtists = splitArtists(track.singer);
    const candidateArtists = splitArtists(candidate.singer);
    if (
      wantedArtists.length &&
      (!candidateArtists.length ||
        !wantedArtists.some((artist) =>
          candidateArtists.some((other) => exactlyEqual(artist, other)),
        ))
    ) {
      return 0;
    }

    const wantedSeconds = parseDurationSeconds(track.interval);
    const candidateSeconds = parseDurationSeconds(
      candidate.interval ?? candidate.duration,
    );
    if (requireDuration && wantedSeconds && !candidateSeconds) return 0;
    if (requireDurationForRelaxed && relaxed && wantedSeconds && !candidateSeconds) return 0;
    if (
      wantedSeconds &&
      candidateSeconds &&
      Math.abs(wantedSeconds - candidateSeconds) > DURATION_TOLERANCE_SECONDS
    ) {
      return 0;
    }

    return exact ? 2 : 1;
  };

  const extractCandidates = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (Array.isArray(container)) return container;
      if (Array.isArray(container?.list)) return container.list;
    }
    return [];
  };

  const extractTrackDetails = (body) => {
    for (const container of [body, body?.data, body?.result]) {
      if (!isRecord(container)) continue;
      const details = {};
      for (const key of ["name", "singer", "artist", "artists", "interval", "duration"]) {
        if (container[key] !== undefined && container[key] !== null && container[key] !== "") {
          details[key] = container[key];
        }
      }
      if (!details.singer) {
        const singer = textOrEmpty(details.artist || details.artists);
        if (singer) details.singer = singer;
      }
      if (Object.keys(details).length > 0) return details;
    }
    return {};
  };

  const normaliseCandidate = (candidate) => {
    if (!isRecord(candidate) || textOrEmpty(candidate.singer)) return candidate;
    const singer = textOrEmpty(candidate.artist || candidate.artists);
    return singer ? { ...candidate, singer } : candidate;
  };

  /**
   * 搜索关键词：去掉版本标记的标题 + 第一位歌手。把 "(Live)"、"My jealousy (Original ver.)" 这类后缀
   * 直接丢给搜索接口会显著降低命中率；酷狗对过长的 msg 返回 400，因此统一截断。
   */
  const buildSearchKeyword = (track) => {
    const primaryArtist = track.singer.split(ARTIST_SEPARATOR)[0].trim();
    const title = stripTitleVariant(track.name).slice(0, SEARCH_KEYWORD_MAX_LENGTH).trim();
    const keyword = [title, primaryArtist].filter(Boolean).join(" ");
    return keyword.length > SEARCH_KEYWORD_MAX_LENGTH ? title : keyword;
  };

  // 公开搜索接口偶尔用 JSONP 包裹；宿主按 json 解析失败时会原样给字符串。
  const parseLooseJson = (body) => {
    if (isRecord(body)) return body;
    if (typeof body !== "string") return undefined;
    const text = body.trim().replace(/^[\w$.]+\s*\(/, "").replace(/\)\s*;?\s*$/, "");
    try {
      const parsed = JSON.parse(text);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  /** 备用搜索：不经过 ChKSz，不扣额度，但仍受整体解析与跨平台时间预算约束。 */
  const performDirectSearch = async (source, keyword, { budget, deadline, state } = {}) => {
    const { directSearch } = getSourcePolicy(source);
    const cacheKey = requestKey(directSearch.endpoint, { w: keyword });
    if (state?.config.smartCache) {
      const cached = readCache(state.responses, cacheKey);
      if (cached?.candidates) return cached.candidates;
    }

    let timeout = REQUEST_TIMEOUT;
    let timeoutCode = REQUEST_TIMEOUT_ERROR;
    if (budget) {
      const remaining = budget.deadline - Date.now();
      if (remaining <= 0) {
        throw pluginError(CROSS_PLATFORM_LIMIT_ERROR, "ChKSz 跨平台兜底已达到请求或时间上限。");
      }
      timeout = Math.min(timeout, remaining);
      timeoutCode = CROSS_PLATFORM_LIMIT_ERROR;
    }
    if (Number.isFinite(deadline)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw pluginError(RESOLUTION_TIMEOUT_ERROR, "SPlayer 播放地址解析已达到时间上限。");
      }
      if (remaining < timeout) {
        timeout = remaining;
        timeoutCode = RESOLUTION_TIMEOUT_ERROR;
      }
    }

    const url = new URL(directSearch.endpoint);
    for (const [key, value] of Object.entries(directSearch.params(keyword))) {
      url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await requestWithTimeout(
        url.toString(),
        {
          method: "GET",
          responseType: "json",
          headers: { ...directSearch.headers },
          timeout: Math.max(1, timeout),
        },
        timeoutCode,
      );
    } catch (error) {
      if (
        isHostCancellationError(error) ||
        isResolutionTimeoutError(error) ||
        isCrossPlatformLimitError(error)
      ) {
        throw error;
      }
      throw pluginError(
        DIRECT_SEARCH_ERROR,
        `${directSearch.name}请求失败：${redactSensitiveData(error?.message ?? error)}`,
      );
    }
    if (state) assertCurrentSession(state);

    const status = Number(response?.status) || 0;
    if (status < 200 || status >= 300) {
      throw pluginError(DIRECT_SEARCH_ERROR, `${directSearch.name}返回 HTTP ${status}。`);
    }
    const body = parseLooseJson(response?.body);
    if (!body) {
      throw pluginError(DIRECT_SEARCH_ERROR, `${directSearch.name}返回的不是有效 JSON。`);
    }
    const candidates = directSearch.candidates(body);
    if (state?.config.smartCache) {
      writeCache(
        state.responses,
        cacheKey,
        { candidates },
        Date.now() + (candidates.length ? CACHE_TTL : UNAVAILABLE_TTL),
      );
    }
    return candidates;
  };

  /**
   * 先走 ChKSz 搜索；它 404/5xx/网络失败或没有结果时，有备用搜索的平台改用备用搜索。
   * 账号类错误、取消和超时原样抛出；备用搜索也失败时抛回 ChKSz 的原始错误，保持通道诊断语义。
   */
  const searchCandidates = async (source, keyword, requestContext = {}) => {
    const policy = getSourcePolicy(source);
    const { search, directSearch } = policy;
    const state = requestContext.state;
    const useDirect = canDirectSearch(state, source);
    const searchCooldown = state ? coolingDown(state.searchCooldowns, source) : 0;
    let providerError;

    if (useDirect && searchCooldown > 0) {
      splayer.log.warn(
        `${policy.name}搜索通道故障冷却中（${searchCooldown} 秒），直接改用${directSearch.name}。`,
      );
    } else {
      try {
        const body = await requestJson(
          search.endpoint,
          { ...search.params, [search.keywordParameter]: keyword },
          requestContext,
        );
        if (state) noteSearchOutcome(state, source, keyword);
        const candidates = extractCandidates(body);
        if (candidates.length || !useDirect) return candidates;
      } catch (error) {
        if (
          !useDirect ||
          isHostCancellationError(error) ||
          isResolutionTimeoutError(error) ||
          isCrossPlatformLimitError(error) ||
          isAccountError(error) ||
          !(isProviderError(error) || isOperationalError(error))
        ) {
          throw error;
        }
        if (state) noteSearchOutcome(state, source, keyword, error);
        providerError = error;
      }
    }

    try {
      const candidates = await performDirectSearch(source, keyword, requestContext);
      splayer.log.info(
        `${policy.name}搜索${providerError ? `失败（${providerError.message}）` : "没有结果"}，${directSearch.name}返回 ${candidates.length} 个候选。`,
      );
      return candidates;
    } catch (error) {
      if (
        isHostCancellationError(error) ||
        isResolutionTimeoutError(error) ||
        isCrossPlatformLimitError(error)
      ) {
        throw error;
      }
      splayer.log.warn(`${error?.message ?? error}`);
      if (providerError) throw providerError;
      return [];
    }
  };

  const findMatchingTracks = async (
    source,
    track,
    requestContext = {},
    matchOptions = {},
  ) => {
    const { search } = getSourcePolicy(source);
    const keyword = buildSearchKeyword(track);
    const candidates = await searchCandidates(source, keyword, requestContext);

    const matches = [];
    for (const rawCandidate of candidates) {
      const candidate = normaliseCandidate(rawCandidate);
      const score = matchScore(track, candidate, matchOptions);
      if (score <= 0 || !isRecord(candidate)) continue;
      const rawId = candidate[search.candidateIdField];
      const id = typeof rawId === "number" ? String(rawId) : textOrEmpty(rawId);
      if (id) matches.push({ candidate, id, score });
    }
    return matches
      .sort((left, right) => right.score - left.score)
      .slice(0, requestContext.state?.config.economyMode ? 1 : CROSS_PLATFORM_MAX_CANDIDATES)
      .map(({ candidate, id }) => ({ candidate, id }));
  };

  const resolveAcrossPlatforms = async (policy, quality, track, deadline, state, primaryError) => {
    const budget = {
      remaining: state.config.economyMode ? 4 : CROSS_PLATFORM_REQUEST_BUDGET,
      deadline: Math.min(deadline, Date.now() + CROSS_PLATFORM_TIME_BUDGET),
    };
    const requestContext = { budget, deadline, state };
    const attempts = [];
    let firstRecoverableError;
    let completedSearch = false;

    const rememberRecoverableError = (error) => {
      if (
        !firstRecoverableError &&
        (isOperationalError(error) || isProviderError(error))
      ) {
        firstRecoverableError = error;
      }
    };

    for (const targetSource of policy.crossPlatform.sources) {
      const targetPolicy = getSourcePolicy(targetSource);
      const cooldownSeconds = coolingDownPlatform(state, targetSource);
      if (cooldownSeconds > 0) {
        attempts.push({ name: targetPolicy.name, outcome: "cooldown", cooldownSeconds });
        splayer.log.warn(
          `${targetPolicy.name} 上游故障冷却中，${cooldownSeconds} 秒内跳过《${track.name}》的跨平台匹配。`,
        );
        continue;
      }
      try {
        const trackHasDuration = parseDurationSeconds(track.interval) > 0;
        const matchOptions = {
          // ChKSz's NetEase search contract does not promise duration. Keep exact
          // title matches usable, but never let an unknown-duration clean title
          // replace a versioned original through the relaxed-match path.
          requireDurationForRelaxed: targetSource === "wy" && trackHasDuration,
          requireDuration: targetSource !== "wy" && trackHasDuration,
        };
        const searchMatchOptions = {
          requireDurationForRelaxed: matchOptions.requireDurationForRelaxed,
        };
        const matches = await findMatchingTracks(
          targetSource,
          track,
          requestContext,
          searchMatchOptions,
        );
        // 搜索本身跑通了才算"这首歌在该平台不存在"；搜索失败只能说明平台不可用。
        completedSearch = true;
        attempts.push({
          name: targetPolicy.name,
          outcome: matches.length ? "candidates" : "no-match",
        });
        for (const { candidate, id } of matches) {
          try {
            const resolution = await resolveOnPlatform(
              targetSource,
              quality,
              id,
              requestContext,
            );
            const details = extractTrackDetails(resolution.body);
            const resolvedCandidate = {
              ...candidate,
              ...details,
            };
            if (
              targetSource === "tx" &&
              matchOptions.requireDuration &&
              parseDurationSeconds(details.interval ?? details.duration) <= 0
            ) {
              splayer.log.warn(
                `${targetPolicy.name} 候选（${id}）详情缺少有效时长，跳过《${track.name}》。`,
              );
              continue;
            }
            if (matchScore(track, resolvedCandidate, matchOptions) <= 0) {
              splayer.log.warn(
                `${targetPolicy.name} 候选（${id}）未通过《${track.name}》的时长校验。`,
              );
              continue;
            }

            splayer.log.info(
              `《${track.name}》在${policy.name}不可用，已改用 ${targetPolicy.name} 播放（${id}）。`,
            );
            return resolution.result;
          } catch (error) {
            if (isHostCancellationError(error)) throw error;
            if (isResolutionTimeoutError(error)) throw error;
            if (isCrossPlatformLimitError(error)) {
              if (firstRecoverableError) throw firstRecoverableError;
              throw error;
            }
            if (isAccountError(error)) throw error;
            rememberRecoverableError(error);
            noteChannelFailure(state, targetSource, error);
            if (coolingDownChannel(state, targetSource) > 0) break;
            splayer.log.warn(
              `${targetPolicy.name} 匹配《${track.name}》失败：${error?.message ?? error}`,
            );
          }
        }
      } catch (error) {
        if (isHostCancellationError(error)) throw error;
        if (isResolutionTimeoutError(error)) throw error;
        if (isCrossPlatformLimitError(error)) {
          if (firstRecoverableError) throw firstRecoverableError;
          throw error;
        }
        if (isAccountError(error)) throw error;
        rememberRecoverableError(error);
        noteChannelFailure(state, targetSource, error);
        attempts.push({ name: targetPolicy.name, outcome: "error", error });
        splayer.log.warn(
          `${targetPolicy.name} 匹配《${track.name}》失败：${error?.message ?? error}`,
        );
      }
    }

    // 一个平台都没能跑完搜索：这是 ChKSz 上游故障，不能报成"没有这首歌"。
    // 但本机网络/超时类错误本身已足够精确，保持原有的 NETWORK_ERROR 语义。
    if (!completedSearch && attempts.length > 0 && !isOperationalError(firstRecoverableError)) {
      const detail = attempts
        .map(({ name, outcome, error, cooldownSeconds }) =>
          outcome === "cooldown"
            ? `${name}（${cooldownSeconds} 秒冷却中，未发起请求）`
            : `${name}（${error?.message ?? "未完成搜索"}）`,
        )
        .join("；");
      throw pluginError(
        CROSS_PLATFORM_UNAVAILABLE_ERROR,
        `${policy.name}无法提供《${track.name}》的播放地址（${primaryError?.message ?? "没有可用音质"}），且跨平台搜索未能完成：${detail}。以上是 ChKSz 服务端的返回状态，不代表歌曲不存在，请稍后重试或更换音源。`,
      );
    }

    if (firstRecoverableError) throw firstRecoverableError;

    if (budget.remaining <= 0 || budget.deadline - Date.now() <= 0) {
      throw pluginError(
        CROSS_PLATFORM_LIMIT_ERROR,
        "ChKSz 跨平台兜底已达到请求或时间上限。",
      );
    }
    return null;
  };

  const resolveUncached = async ({ source, quality, id, track }, state) => {
    const { policy } = buildTrackParams(source, id, quality);
    const descriptor = getTrackDescriptor(track);
    const deadline = Date.now() + RESOLUTION_TIME_BUDGET;
    const canCrossSearch =
      Boolean(policy.crossPlatform) &&
      Boolean(descriptor.name) &&
      state.config.crossPlatformFallback;

    const primaryCooldownSeconds = coolingDownChannel(state, source);
    if (primaryCooldownSeconds > 0) {
      const cooldownError = pluginError(
        CHANNEL_COOLDOWN_ERROR,
        `${policy.name}上游通道冷却中（还剩 ${primaryCooldownSeconds} 秒），跳过本次主渠道请求。`,
      );
      if (!canCrossSearch) throw cooldownError;

      const fallback = await resolveAcrossPlatforms(
        policy,
        quality,
        descriptor,
        deadline,
        state,
        cooldownError,
      );
      if (fallback) return fallback;
      throw pluginError(
        CROSS_PLATFORM_UNAVAILABLE_ERROR,
        `${cooldownError.message}且在其他平台中未匹配到《${descriptor.name}》。请稍后重试或更换音源。`,
      );
    }

    try {
      const resolution = await resolveOnPlatform(source, quality, id, { deadline, state });
      // 成功也留一行：宿主只在插件抛错时写日志，没有这行就分不清"插件没被调用"和"插件已成功返回"。
      splayer.log.info(
        `《${descriptor.name || id}》已由${policy.name}解析，交付音质 ${resolution.result.quality}。`,
      );
      return resolution.result;
    } catch (error) {
      noteChannelFailure(state, source, error);
      const canCrossSearchAfterFailure =
        canCrossSearch &&
        (isUnavailableQualityError(error) || isUpstreamUnavailableError(error));
      if (!canCrossSearchAfterFailure) throw error;

      const fallback = await resolveAcrossPlatforms(policy, quality, descriptor, deadline, state, error);
      if (fallback) return fallback;

      const platformNames = policy.crossPlatform.sources
        .map((target) => getSourcePolicy(target).name)
        .join("、");
      if (isUpstreamUnavailableError(error)) {
        throw pluginError(
          CROSS_PLATFORM_UNAVAILABLE_ERROR,
          `${policy.name}无法提供《${descriptor.name}》的播放地址（${error.message}），且在 ${platformNames} 中未匹配到同一首歌。以上是 ChKSz 服务端的返回状态，不代表歌曲不存在，请稍后重试或更换音源。`,
        );
      }
      throw pluginError(
        "CHKSZ_TRACK_UNAVAILABLE",
        `${policy.name}无法提供《${descriptor.name}》的播放地址（${error.message}），且在 ${platformNames} 中未匹配到同一首歌。`,
      );
    }
  };

  const resolve = async (input) => {
    const state = getSession();
    const { requestedQuality } = buildTrackParams(input.source, input.id, input.quality);
    const key = JSON.stringify([input.source, String(input.id), requestedQuality, getTrackDescriptor(input.track)]);
    const result = await sharePending(state, state.pending, key, () => resolveUncached(input, state));
    assertCurrentSession(state);
    return { ...result };
  };

  const requestAction = async (source, action, id) => {
    const state = getSession();
    const { endpoint, params } = buildActionRequest(source, action, id);
    const key = requestKey(endpoint, params);
    if (state.config.smartCache) {
      const metadata = readCache(state.metadata, JSON.stringify([source, String(id)]));
      if (hasActionMetadata(metadata, action)) return metadata;
      const cached = readCache(state.actions, key);
      if (hasActionMetadata(cached, action)) return cached;
    }
    if (!state.config.metadataFallback) return {};
    return sharePending(state, state.actionPending, key, async () => {
      const body = await requestJson(endpoint, params, { state, action });
      if (state.config.smartCache) writeCache(state.actions, key, body, Date.now() + CACHE_TTL);
      return body;
    });
  };

  return { requestAction, resolve };
};

const resolutionImplementation = createResolutionCore();
const { requestAction } = resolutionImplementation;
const resolutionCore = { resolve: resolutionImplementation.resolve };

const resolveUrl = async ({ source, quality, musicInfo }) => {
  const id = getMusicId(source, musicInfo);
  return resolutionCore.resolve({ source, quality, id, track: musicInfo });
};

const textFromValue = (value) => {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  for (const key of ["lyric", "text", "content"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return "";
};

const extractTextField = (body, names) => {
  for (const container of [body, body?.data, body?.result]) {
    if (!isRecord(container)) continue;
    for (const name of names) {
      const text = textFromValue(container[name]);
      if (text) return text;
    }
  }
  return "";
};

const buildActionRequest = (source, action, id) => {
  const policy = getSourcePolicy(source);
  const actionPolicy = policy.actions[action];
  const params = {
    [policy.identity.idParameter]: id,
    ...actionPolicy.params,
  };

  if (actionPolicy.request === "trackDetails") {
    params[policy.playback.qualityParameter] = policy.playback.qualityValues.lq;
    params.type = "json";
  }

  return {
    endpoint: actionPolicy.endpoint ?? policy.playback.endpoint,
    params,
  };
};

const getLyric = async ({ source, musicInfo }) => {
  const id = getMusicId(source, musicInfo);
  const body = await requestAction(source, "musicLyric", id);

  return {
    lyric: extractTextField(body, ["lyric", "lrc"]),
    tlyric: extractTextField(body, ["tlyric", "tlrc", "translation"]),
    rlyric: extractTextField(body, ["rlyric", "romalrc", "romanization"]),
    awlyric: extractTextField(body, ["awlyric", "yrc", "qrc", "krc"]),
  };
};

const getCover = async ({ source, musicInfo }) => {
  const id = getMusicId(source, musicInfo);
  const body = await requestAction(source, "musicPic", id);

  const cover = extractTextField(body, [
    "cover",
    "coverUrl",
    "pic",
    "picUrl",
    "albumCover",
  ]);
  return { url: /^https?:\/\//i.test(cover) ? cover : "" };
};

const createRuntimeAdapter = (runtime) => ({
  register(metadata) {
    runtime.register(metadata);
  },
  bind({ musicUrl, musicLyric, musicPic }) {
    runtime.on("musicUrl", musicUrl);
    runtime.on("musicLyric", musicLyric);
    runtime.on("musicPic", musicPic);
  },
});
const runtimeAdapter = createRuntimeAdapter(splayer);
runtimeAdapter.register({
  sources: Object.fromEntries(
    Object.entries(SOURCE_POLICIES).map(([source, policy]) => [
      source,
      {
        name: policy.name,
        actions: ["musicUrl", "musicLyric", "musicPic"],
        qualities: QUALITY_NAMES,
      },
    ]),
  ),
  settings: [
    {
      key: API_KEY_SETTING,
      type: "text",
      label: "ChKSz API Key",
      description: "仅保存在 SPlayer 本机设置中；不要分享配置文件。",
      default: "",
      placeholder: "chksz_...",
    },
    {
      key: CROSS_PLATFORM_SETTING,
      type: "switch",
      label: "主渠道不可用时跨平台兜底",
      description:
        "当前来源无版权或上游故障时，按歌名、歌手和时长在其他平台匹配同一首歌，再使用目标平台自己的 ID 解析。每次匹配会额外消耗 ChKSz 额度。",
      default: true,
    },
    {
      key: DIRECT_SEARCH_SETTING,
      type: "switch",
      label: "ChKSz 搜索不可用时改用 QQ 音乐公开搜索",
      description:
        "ChKSz 的 QQ 音乐搜索返回 404、5xx 或没有结果时，改用 QQ 音乐公开搜索接口找同一首歌的 mid，再交给 ChKSz 按 mid 解析。公开搜索不消耗 ChKSz 额度。",
      default: true,
    },
    {
      key: "smartCache",
      type: "switch",
      label: "智能请求复用",
      description: "合并相同播放请求；缓存明确有效的地址与搜索结果，短暂跳过不可用音质。仅保存在内存，切换配置会清空。",
      default: true,
    },
    {
      key: "playableFirst",
      type: "switch",
      label: "可播放优先（母带档留到最后）",
      description:
        "默认母带优先，拿最好的音质。网络或设备吃不下 46–150MB 的母带文件时打开：改为先取 hires、无损等通用档位，把网易云的母带/音效档排到最后。",
      default: false,
    },
    {
      key: "verifyDelivery",
      type: "switch",
      label: "交付体检（返回前验证地址能拉流）",
      description:
        "拿到播放地址后先取前几个字节确认可访问，地址被拒或打不开时自动改用下一档。这是 CDN 请求，不消耗 ChKSz 额度。",
      default: true,
    },
    {
      key: "economyMode",
      type: "switch",
      label: "省配额模式（减少音质与候选探测）",
      description: "只尝试目标音质和标准音质；跨平台每个平台只探测一个候选、最多四次请求。可能错过中间音质或可播版本。",
      default: false,
    },
    {
      key: "metadataFallback",
      type: "switch",
      label: "允许为歌词和封面额外请求",
      description: "关闭后仅返回已有缓存中的歌词、封面，不为这些动作单独调用 ChKSz。",
      default: true,
    },
  ],
});
runtimeAdapter.bind({
  musicUrl: resolveUrl,
  musicLyric: getLyric,
  musicPic: getCover,
});

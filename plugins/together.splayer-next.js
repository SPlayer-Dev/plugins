/**
 * @name        一起听 与 跨端续播
 * @id          together.splayer-next
 * @version     0.2.4
 * @description 把 SPlayer-Next 接入网易云「一起听」房间（可在电脑端建房并邀请，也可自动接入），并支持跨端续播；播放/暂停可双向同步，云端切歌与主动通知受宿主 API 限制
 * @author      lakyTao
 * @homepage    https://github.com/lakyTao/splayer-together-plugin
 * @type        control
 * @apiLevel    2
 * @grant       network,control,ui
 * @updateUrl    https://raw.githubusercontent.com/SPlayer-Dev/plugins/main/plugins/together.splayer-next.js
 * @changelog    0.2.4\n- 首次投稿插件市场（SPlayer-Dev/plugins）\n- 插件功能与 0.2.3 完全一致：本版仅为市场收录补充 @updateUrl / @changelog 字段
 */

/*
 * ============================================================================
 * 形态 A：官方 control 插件（单文件、node:vm 沙箱）
 * ----------------------------------------------------------------------------
 * 本文件是 SPlayer-Next 插件的最终交付物，必须满足沙箱约束：
 *   - 没有 Node 内置模块、没有 require/import、没有 DOM/Electron；
 *   - 只能访问宿主注入的全局 splayer（request / storage / player / getSetting / log）；
 *   - 顶层同步执行限 5 秒，耗时逻辑一律放进事件回调或定时器。
 *
 * 房间保活：每轮轮询复查房间（status/get，同时刷新成员），并按服务端 timeSpan
 * （≈30s）调用 /api/listen/together/heartbeat 续期——只轮询 sync/playlist/get
 * 并不续期，历史上房间失效与此有关（心跳必须带真实 songId，空值会 code=400）。
 *
 * 房间状态机（2026-09-16 实测）：纯 HTTP 用 room/create 建的房初始
 * status=NOT_CONNECTED（effectiveDurationMs=1800000 / waitMs=120000），但**可以被
 * 官方客户端加入**；有真实客户端接入后 status 转为 CONNECTED、waitMs 变 null。
 * room/check 只是只读可用性查询（人满返回 FULL），不是激活握手。
 *
 * 进度锚点（2026-09-16 实修）：云端 `playCommand.progress` 是**固定锚点**，必须配
 * `serverSeq`（服务端 epoch ms）换算"此刻应播到哪"；且**只在 clientSeq 变化（新指令）时**
 * 才做 seek。旧实现每轮轮询都 `anchorAt = now` 并按估算进度 seek，本地每播一段就被拉回，
 * 表现为「进度条播放一段又跳回去循环」。手机端拉进度条会下发
 * `commandType:"PROGRESS"`（triggerType MANUAL）——同样按新指令处理。
 *
 * ⚠️ 两个无法回避的能力降级（宿主 API 限制，不是实现取舍）：
 *   1) 无法按 songId 切歌（宿主 API 限制）。splayer.player 只有 play/pause/next/prev/seek/
 *      setVolume，没有「播放指定曲目」。缓解：内置 MCP 桥（enableMcpPlay + mcpPort/mcpKey）
 *      用本机 MCP 的 play_track 让本地跟随云端切歌；未配置时退化为日志提示/手动切歌。
 *      彻底修法见 docs/upstream/player-playTrack.md（上游给插件 API 加 player.playTrack）。
 *      跨端续播仍只在「快照歌曲 == 当前曲目」时才真正 seek，否则只恢复播放态。
 *   2) 无法主动弹通知。control 插件没有任何主动 UI 通知 API（自定义 toast 只能由用户
 *      点击歌曲菜单经 menuClick 返回）。因此异常只能写日志，等待用户在日志中看到，
 *      或由用户点击歌曲菜单主动查询（「Cookie 状态」菜单）。
 *
 * Cookie 来源（0.2.3，按优先级）：
 *   1) 本机桥接：运行 tools/cookie-bridge.mjs（只读 library.db 的 account_sessions，
 *      经 127.0.0.1 提供 GET /cookie）——插件自动读取并缓存到 splayer.storage('autoCookie')；
 *   2) 设置项 neteaseCookie：用户手工粘贴；
 *   3) 缓存：上一次桥接/手工留下的 autoCookie。
 *   Cookie 失效后每 60s 低频探测 + 桥接刷新，恢复即自动继续同步。
 *   ⚠️ 不要在插件里请求 /api/login/qrcode/*（扫码登录）：其响应会 Set-Cookie 污染 Electron
 *      默认会话罐，而 net.fetch 在罐里有该域 Cookie 时会**整份覆盖**请求头（只剩 NMTID），
 *      之后连手工 Cookie 也失效（云端 code=301）。已移除扫码登录，改用上面的本机桥接。
 * ============================================================================
 */

(function () {
  "use strict";

  // ------------------------------------------------------------------ 常量
  var SEEK_TOLERANCE_MS = 2000; // 跨端续播 seek 容忍带（PDD §7）
  var REMOTE_APPLY_QUIET_MS = 3000; // 云端指令落地后的回环抑制窗
  var SNAPSHOT_WRITE_INTERVAL_MS = 5000; // 快照写入节流
  var DEFAULT_POLL_INTERVAL_MS = 5000; // 云端轮询（兼心跳保活）
  var DISCOVERY_INTERVAL_MS = 15000; // 未进房时「自动发现房间」的间隔
  var DEFAULT_HEARTBEAT_MS = 30000; // 云端心跳保活间隔（实测服务端 timeSpan≈30s）
  var PAUSE_CONFIRM_MS = 1500; // 非播放态确认窗：宿主切歌会瞬时发 stopped/paused，不能直接当用户暂停上报
  var LIST_ADD_WAIT_MS = 1200; // 发 ADD 后等另一端同步列表再 GOTO（VPS-HTTP §4.4）
  var LIST_ADD_COOLDOWN_MS = 30000; // 同歌补发冷却：服务端列表同步有延迟，期间轮询重建的 cloudList 不含它，快速来回切歌会触发重复 ADD
  var AUTO_END_WINDOW_MS = 8000; // 上一首播到距结尾不足该窗口就切歌 → 视为「自然播完」，不是用户主动切歌
  var AUTO_ADVANCE_CONFIRM_MS = 3000; // 自然播完后的确认窗：等云端裁定下一首（对方 AUTO NEXT），别把本地队列下一首塞进房间
  var SEEK_REPORT_MIN_MS = 2500; // 采样发现同曲内进度跳变超过该值 → 视为用户拖进度条，上报 PROGRESS
  var SEEK_SAMPLE_INTERVAL_MS = 1000; // 拖进度检测的采样间隔（独立于云端轮询，压低对齐延迟）
  var TRACK_CHANGE_GRACE_MS = 3000; // 切歌过渡期内位置不可信（宿主过渡/MCP 桥换歌），采样器跳过
  var LOCAL_STATE_GRACE_MS = 2500; // 本地播放/暂停刚变化时，轮询不得做播放态对齐（否则云端旧的 PLAY 会在确认窗内把用户的暂停强行恢复）
  var DEFAULT_API_BASE = "https://music.163.com";
  var REQUEST_TIMEOUT_MS = 15000; // 单次云端请求超时（宿主上限 60s）
  var REQUEST_RETRIES = 3; // 只读请求的网络失败重试次数（3 次指数退避：500/1000/2000ms）
  var COOKIE_RETRY_INTERVAL_MS = 60000; // Cookie 失效后的自愈探测间隔
  var COOKIE_BRIDGE_PORT = 14560; // 本机 Cookie 桥接脚本默认端口（tools/cookie-bridge.mjs；0 = 关闭）
  var DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // ------------------------------------------------------------ 设置项读取
  function setting(key, fallback) {
    var value = splayer.getSetting(key);
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  function config() {
    // Cookie 来源优先级：本机桥接（SPlayer 已登录会话，最权威/最新）
    //   > 设置项（用户手工粘贴）> 插件缓存的登录 Cookie（storage.autoCookie）
    return {
      cookie: runtime.bridgeCookie || String(setting("neteaseCookie", "")) || runtime.autoCookie,
      apiBase: String(setting("apiBaseUrl", DEFAULT_API_BASE)) || DEFAULT_API_BASE,
      roomId: String(setting("roomId", "")),
      inviterId: String(setting("inviterId", "")),
      inviteeUserId: String(setting("inviteeUserId", "")),
      enableTogether: setting("enableTogetherListen", false) === true,
      enableAutoResume: setting("enableAutoResume", true) === true,
      enableMcpPlay: setting("enableMcpPlay", true) === true,
      mcpPort: Math.max(1024, Number(setting("mcpPort", 14559)) || 14559),
      mcpKey: String(setting("mcpKey", "")),
      pollIntervalMs: Math.max(2000, Number(setting("pollIntervalMs", DEFAULT_POLL_INTERVAL_MS)) || DEFAULT_POLL_INTERVAL_MS),
    };
  }

  // ---------------------------------------------------------------- 运行时
  var runtime = {
    polling: null,
    discovery: null,
    seekSampler: null,
    lastTrackChangeAt: 0,
    pendingLocalReport: false, // 本地切歌上报（ADD→GOTO）在途：期间轮询不得发起 MCP 跟随
    pendingReportTarget: "", // 在途上报的目标歌；云端回声确认到它才解除在途
    pendingReportAt: 0,
    lastLocalStateChangeAt: 0, // 本地播放/暂停最近一次变化时刻；刚变化时轮询不得对齐播放态
    mcpFollowedSongId: "", // 最近一次 MCP 跟随的目标歌：其 trackChange 是跟随回声，绝不能再上报
    mcpFollowedAt: 0,
    clientSeq: 0,
    selfUserId: "",
    roomId: "",
    cloudSongId: "",
    cloudPlaying: false,
    anchorPos: 0,
    anchorAt: 0,
    lastRemoteApplyAt: 0,
    lastSnapshotAt: 0,
    localTrackId: "",
    localTrackTitle: "",
    localArtist: "",
    localPlaying: false,
    localPosition: 0,
    cookieExpired: false,
    warnedSwitch: "",
    members: [],
    roomStatus: "",
    cloudList: [],
    recentAddAt: {},
    cloudSeq: -1,
    commandIsNew: false,
    forceApplyCommand: false,
    pendingPause: null,
    pendingAutoGoto: null,
    autoAdvancePending: false,
    localDuration: 0,
    heartbeatAt: 0,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_MS,
    heartbeatOk: 0,
    netErrorStreak: 0, // 连续网络失败计数：恢复时记一条 info
    autoCookie: "", // 插件缓存的登录 Cookie（来自本机桥接；storage: autoCookie）
    bridgeCookie: "", // 从本机桥接脚本读到的 SPlayer 已登录 Cookie（优先级最高，运行时最新）
    cookieRetry: null, // Cookie 失效后的自愈探测定时器
  };

  /** 是否处于「需要重新获取 Cookie」状态（设置项与自动 Cookie 都不可用） */
  function cookieMissing() {
    return !config().cookie;
  }

  function logInfo() {
    splayer.log.info.apply(null, ["[一起听]"].concat(Array.prototype.slice.call(arguments)));
  }
  function logWarn() {
    splayer.log.warn.apply(null, ["[一起听]"].concat(Array.prototype.slice.call(arguments)));
  }
  function logError() {
    splayer.log.error.apply(null, ["[一起听]"].concat(Array.prototype.slice.call(arguments)));
  }

  /**
   * 云端 Cookie 失效：暂停同步并进入自愈模式（⚠️ 无法主动弹通知，只能写日志）。
   * - 每 COOKIE_RETRY_INTERVAL_MS 低频探测一次，Cookie 恢复即自动重新同步；
   * - 用户可运行本机桥接脚本（tools/cookie-bridge.mjs），插件会自动读取并缓存该 Cookie。
   */
  function handleCookieExpired(err) {
    if (runtime.cookieExpired) return;
    runtime.cookieExpired = true;
    stopPolling();
    scheduleCookieRetry();
    logError(
      "网易云 Cookie 已失效（" +
        (err && err.message ? err.message : "云端返回 301") +
        "）。同步已暂停；请确认本机 Cookie 桥接（cookie-bridge.mjs）在运行，" +
        "再从歌曲菜单点「一起听：从本机登录会话同步 Cookie」；插件仍在每 " +
        COOKIE_RETRY_INTERVAL_MS / 1000 +
        "s 探测一次，恢复后会自动继续同步。",
    );
  }

  /** Cookie 失效后的低频自愈探测：一旦云端响应恢复（如重新登录/网络恢复）自动重新同步 */
  function scheduleCookieRetry() {
    if (runtime.cookieRetry) return;
    runtime.cookieRetry = setInterval(function () {
      if (!runtime.cookieExpired || !config().enableTogether) {
        clearCookieRetry();
        return;
      }
      // 先尝试从本机 SPlayer 登录会话刷新 Cookie（若桥接脚本在运行），再探测是否恢复
      refreshCookieFromBridge()
        .then(function () {
          return fetchRoomStatus();
        })
        .then(function () {
          runtime.cookieExpired = false;
          clearCookieRetry();
          logInfo("Cookie 已恢复有效，自动重新开始同步");
          joinRoom(true);
        })
        .catch(function () {
          /* 仍未恢复：继续等下轮探测（fetchRoomStatus 的重试已是网络退避级） */
        });
    }, COOKIE_RETRY_INTERVAL_MS);
  }

  function clearCookieRetry() {
    if (runtime.cookieRetry) {
      clearInterval(runtime.cookieRetry);
      runtime.cookieRetry = null;
    }
  }

  /**
   * 统一取业务数据。⚠️ 网易云响应结构不统一：
   * - status/get、sync/playlist/get、room/create、invite/message/send、end/v2 都包在 data 里；
   * - 而 nuser/account/get、user/getfollows 直接在顶层（无 data）。
   * 两种都能兼容，避免再出现「未取到自身 userId」/「没有拉到关注列表」这类解析失败。
   */
  function payloadData(payload) {
    if (!payload || typeof payload !== "object") return {};
    return payload.data || payload;
  }

  function parseCookieValue(cookie, name) {
    var parts = String(cookie || "").split(";");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      var eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
    }
    return "";
  }

  // -------------------------------------------------- 网易云一起听云端客户端
  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function isCookieExpiredMessage(err) {
    return !!err && String(err.message || "").indexOf("COOKIE_EXPIRED") >= 0;
  }

  function cookieExpiredError(detail) {
    var err = new Error(detail ? "COOKIE_EXPIRED " + detail : "COOKIE_EXPIRED");
    err.cookieExpired = true;
    return err;
  }

  /** 业务错误（如云端 code=488）不重试：重发同样的指令只会重复报错 */
  function noRetryError(message) {
    var err = new Error(message);
    err.retryable = false;
    return err;
  }

  /**
   * 表单 POST 的底层封装：返回原始 { status, headers, body }。
   * - 只读请求可传 { retries: REQUEST_RETRIES }，网络失败按 3 次指数退避重试；
   * - 业务错误与 Cookie 失效不重试；
   * - Cookie 失效（HTTP 301/401）抛 cookieExpiredError，由上层统一进入自愈。
   */
  function cloudRequest(path, params, options) {
    options = options || {};
    var cfg = config();
    var cookie = options.cookie === undefined ? cfg.cookie : String(options.cookie || "");
    if (!cookie && options.requireCookie !== false) {
      return Promise.reject(new Error("未配置网易云 Cookie"));
    }
    var form = { csrf_token: parseCookieValue(cookie, "__csrf") };
    for (var key in params) {
      if (Object.prototype.hasOwnProperty.call(params, key)) form[key] = String(params[key]);
    }
    var body = Object.keys(form)
      .map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(form[k]);
      })
      .join("&");
    var headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://music.163.com",
      "User-Agent": DEFAULT_UA,
    };
    if (cookie) headers.Cookie = cookie;
    var retries = Math.max(0, Number(options.retries) || 0);

    var attempt = function (n) {
      return splayer
        .request(cfg.apiBase + path, {
          method: "POST",
          headers: headers,
          body: body,
          timeout: Math.max(1000, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS),
          responseType: "json",
        })
        .then(function (res) {
          if (!res || res.status === 301 || res.status === 401) {
            throw cookieExpiredError("(http=" + (res ? res.status : "no-response") + ")");
          }
          return res;
        })
        .catch(function (err) {
          var retryable = !isCookieExpiredMessage(err) && (!err || err.retryable !== false);
          if (!retryable || n >= retries) throw err;
          var wait = Math.min(2000, 500 * Math.pow(2, n));
          logWarn("云端请求失败（第 " + (n + 1) + " 次），" + wait + "ms 后重试：" + (err && err.message ? err.message : err));
          return delay(wait).then(function () {
            return attempt(n + 1);
          });
        });
    };
    return attempt(0);
  }

  /** 表单 POST：云端 code 301 视为 Cookie 失效，非 200 视为业务错误 */
  function postForm(path, params, options) {
    return cloudRequest(path, params, options)
      .then(function (res) {
        var payload = res.body || {};
        if (payload.code === 301) {
          throw cookieExpiredError(
            "(http=" +
              res.status +
              ", code=" +
              payload.code +
              ", msg=" +
              (payload.message || payload.msg || "-") +
              ")",
          );
        }
        if (payload.code !== 200) throw noRetryError("云端返回 code=" + payload.code);
        return payload;
      })
      .catch(function (err) {
        if (isCookieExpiredMessage(err)) handleCookieExpired(err);
        throw err;
      });
  }

  function acceptInvitation(roomId, inviterId) {
    return postForm("/api/listen/together/play/invitation/accept", {
      roomId: roomId,
      inviterId: inviterId,
    });
  }

  function fetchRoomData(roomId) {
    // 只读请求：网络抖动时重试（3 次指数退避），断网恢复后无需人工干预
    return postForm("/api/listen/together/sync/playlist/get", { roomId: roomId }, { retries: REQUEST_RETRIES });
  }

  /**
   * 读取当前房间状态：POST /api/listen/together/status/get
   * → { inRoom, roomId, creatorId, members }，房间 ID 因此无需手工填写。
   *
   * ⚠️ 成员权威来源是 roomInfo.roomUsers[]，**不是** playlist.version[]
   *    —— version 只含「上报过列表版本的人」，会漏掉未上报的成员。
   */
  function fetchRoomStatus() {
    return postForm("/api/listen/together/status/get", {}, { retries: REQUEST_RETRIES }).then(function (payload) {
      var data = payloadData(payload);
      var info = data.roomInfo || {};
      var inRoom = data.inRoom === true;
      return {
        inRoom: inRoom,
        roomId: inRoom && info.roomId ? String(info.roomId) : "",
        creatorId: info.creatorId ? String(info.creatorId) : "",
        // 房间连接态：NOT_CONNECTED（尚无真实客户端接入）/ CONNECTED（有人接入）
        status: data.status ? String(data.status) : "",
        members: (info.roomUsers || []).map(function (u) {
          return { userId: String(u.userId), nickname: String(u.nickname || "") };
        }),
      };
    });
  }

  /** 只关心房间 ID 时的便捷封装 */
  function discoverRoomId() {
    return fetchRoomStatus().then(function (status) {
      return status.roomId;
    });
  }

  /** 把缓存的成员列表格式化为「昵称(userId)」文本 */
  function describeMembers() {
    return runtime.members
      .map(function (m) {
        return (m.nickname ? m.nickname : "(无昵称)") + "(" + m.userId + ")";
      })
      .join("、");
  }

  /** PC 端建房；返回 { roomId, creatorId } */
  function createRoom() {
    return postForm("/api/listen/together/room/create", { refer: "songplay_more" }).then(function (payload) {
      var data = payloadData(payload);
      var info = data.roomInfo || {};
      var roomId = info.roomId ? String(info.roomId) : "";
      if (!roomId) throw new Error("建房未返回 roomId（type=" + (data.type || "?") + "）");
      return { roomId: roomId, creatorId: info.creatorId ? String(info.creatorId) : "" };
    });
  }

  /** 向指定 userId 发送原生一起听邀请（手机端会收到邀请卡片） */
  function inviteToRoom(roomId, acceptorId) {
    return postForm("/api/listen/together/invite/message/send", {
      roomId: roomId,
      acceptorId: acceptorId,
    }).then(function (payload) {
      var data = payloadData(payload);
      return data.result === true;
    });
  }

  /** 取自身网易云 userId（列表 version 需要，权威来源是账号接口而非房间 version[0]） */
  function ensureSelfUserId() {
    if (runtime.selfUserId) return Promise.resolve(runtime.selfUserId);
    return postForm("/api/nuser/account/get", {}, { retries: REQUEST_RETRIES }).then(function (payload) {
      // 实测该接口返回 {code, account, profile}（顶层，无 data 包裹），两种结构都兼容
      var root = payload || {};
      var d = payloadData(payload);
      // 保留原始类型（userId 一般是数字，服务端如 api-enhanced 也按数字上报 version）
      var id = (d.profile && d.profile.userId) || (d.account && d.account.id) || d.userId || "";
      if (id) runtime.selfUserId = id;
      return runtime.selfUserId;
    });
  }

  /** 递增自身在列表 version 中的版本号；首次参与则新增一条 version=1 */
  function bumpVersion(versions, myId) {
    var found = false;
    var out = versions.map(function (v) {
      if (String(v.userId) === String(myId)) {
        found = true;
        return { userId: v.userId, version: Number(v.version || 0) + 1 };
      }
      return { userId: v.userId, version: Number(v.version || 0) };
    });
    if (!found) out.push({ userId: myId, version: 1 });
    return out;
  }

  /**
   * displayList.result 归一化为 songId 字符串数组。
   * ⚠️ 实测（探针 + QListenTogether 源码 `.join(',')`）：result 是**纯 songId 字符串数组**，
   * 旧实现按 `item.songId`（对象）解析，全部得到 "undefined" → 任何歌都「不在列表」，
   * 插件因此反复补 ADD（同一首被重复追加、列表膨胀到 35+ 且两端下一首混乱）。
   * 兼容对象形态以防服务端调整。
   */
  function normalizeSongIds(result) {
    return (result || []).map(function (item) {
      if (item && typeof item === "object") return String(item.songId);
      return String(item);
    });
  }

  /**
   * 目标歌曲不在房间列表里时先发 ADD（递增自身 version），等另一端同步后再 GOTO。
   * 依据 VPS-HTTP.md §4.4：「目标歌曲不在 display_list 时，必须先递增版本发送 ADD，
   * 等待另一端同步后再发送 GOTO」——只发 GOTO 会导致手机不跟随 / 云端 code=488。
   *
   * ⚠️ 只在**本机主动切歌**（onTrackChange 上报路径）调用；轮询发现「云端歌曲不在列表」
   * 时**不要**补 ADD——列表由各端客户端自己维护，官方客户端切的歌它自己会 ADD，
   * 插件再补一遍会把没选过的歌塞进两端列表（真机实测混入奇怪的歌）。
   *
   * ⚠️ 不做「ADD 后复查」：实测 displayList 视图反映不了真实房间列表（ADD 明明生效、
   * GOTO 都成功了，复查仍报「不在列表」），复查只会刷警告日志，无鉴别力。
   */
  function ensureSongInRoomList(roomId, songId) {
    var wanted = String(songId);
    // 已知在房间列表里的歌直接放行，省一次列表拉取（快速连续切歌时明显更跟手）
    if (runtime.cloudList.indexOf(wanted) >= 0) return Promise.resolve(true);
    // 冷却期内不重复补发：同一首歌短时间反复切时避免重复 ADD（对端重复收到「添加歌曲」）
    if (Date.now() - Number(runtime.recentAddAt[wanted] || 0) < LIST_ADD_COOLDOWN_MS) {
      return Promise.resolve(false);
    }
    return fetchRoomData(roomId).then(function (payload) {
      var data = payloadData(payload);
      var playlist = data.playlist || {};
      var ids = normalizeSongIds(playlist.displayList && playlist.displayList.result);
      if (ids.indexOf(wanted) >= 0) return true;
      return ensureSelfUserId().then(function (myId) {
        return postForm("/api/listen/together/sync/list/command/report", {
          roomId: roomId,
          playlistParam: JSON.stringify({
            commandType: "ADD",
            version: bumpVersion(playlist.version || [], myId),
            playMode: "ORDER_LOOP",
            anchorSongId: wanted,
            anchorPosition: -1,
            randomList: [wanted],
            displayList: [wanted],
          }),
        }).then(function () {
          // 乐观更新：马上认为列表里已有它，避免短时间内为同一首歌再发 ADD
          if (runtime.cloudList.indexOf(wanted) < 0) runtime.cloudList.push(wanted);
          runtime.recentAddAt[wanted] = Date.now();
          logInfo("歌曲 " + wanted + " 不在房间列表，已发 ADD（userId=" + myId + "），稍候 GOTO");
          return new Promise(function (resolve) {
            setTimeout(resolve, LIST_ADD_WAIT_MS);
          });
        });
      });
    });
  }

  function reportPlayCommand(roomId, command) {
    return postForm("/api/listen/together/play/command/report", {
      roomId: roomId,
      commandInfo: JSON.stringify(command),
    });
  }

  // ------------------------------------------------------------ 房间状态同步
  /**
   * 把云端返回的房间数据落到本地。
   *
   * ⚠️ 锚点只在**云端发来新指令**（clientSeq 变化）时更新，且优先用云端命令自带的
   * **服务端 epoch 时间戳 serverSeq** 作为锚点时间。
   * 旧实现在每一轮轮询都做 `anchorAt = Date.now()`——等于把固定不变的 `progress`
   * 反复重锚到「现在」，估算位置永远停在 `progress`，本地每播一段就被 seek 回去，
   * 实测表现为「**进度条播放一段又跳回去循环**」。
   */
  function applyRoomData(data) {
    var play = data.playCommand || {};
    var result = data.playlist && data.playlist.displayList && data.playlist.displayList.result;
    var seq = Number(play.clientSeq || 0);
    runtime.commandIsNew = seq !== runtime.cloudSeq;
    runtime.cloudSeq = seq;
    runtime.clientSeq = Math.max(runtime.clientSeq, seq);
    runtime.cloudSongId = String(play.targetSongId || "");
    runtime.cloudPlaying = (play.playStatus || "PLAY") === "PLAY";
    if (runtime.commandIsNew) {
      runtime.anchorPos = Number(play.progress || 0);
      var serverAt = Number(play.serverSeq || 0);
      // serverSeq 是服务端 epoch ms；与本地时钟差得离谱（>10min）时不信任，退回本地时间
      runtime.anchorAt =
        serverAt > 0 && Math.abs(Date.now() - serverAt) < 600000 ? serverAt : Date.now();
      // 双向对账日志：云端每条新指令都记录（含我们自己指令的回声），出问题可完整还原时序
      logInfo(
        "云端指令: " +
          (play.commandType || "?") +
          " → " +
          runtime.cloudSongId +
          " (userId=" +
          play.userId +
          ", trigger=" +
          (play.triggerType || "-") +
          ", status=" +
          (play.playStatus || "-") +
          ", progress=" +
          (play.progress || 0) +
          ", seq=" +
          seq +
          ")",
      );
    }
    runtime.cloudList = normalizeSongIds(result);
  }

  /** 远端「此刻应播到的位置」＝锚点进度 + 播放时长（暂停则不推进） */
  function estimateCloudPosition() {
    if (!runtime.cloudPlaying) return Math.max(0, runtime.anchorPos);
    return Math.max(0, runtime.anchorPos + (Date.now() - runtime.anchorAt));
  }

  function reportGoto(commandType, progress, playStatus, formerSongId, targetSongId) {
    if (!runtime.roomId) return Promise.resolve(false);
    runtime.clientSeq += 1;
    return reportPlayCommand(runtime.roomId, {
      commandType: commandType || "GOTO",
      progress: progress,
      playStatus: playStatus,
      formerSongId: formerSongId || targetSongId,
      targetSongId: targetSongId,
      clientSeq: runtime.clientSeq,
    })
      .then(function () {
        runtime.cloudSongId = targetSongId;
        runtime.cloudPlaying = playStatus === "PLAY";
        runtime.anchorPos = progress;
        runtime.anchorAt = Date.now();
        logInfo(
          "已上报 " +
            (commandType || "GOTO") +
            " → " +
            targetSongId +
            " (status=" +
            playStatus +
            ", progress=" +
            progress +
            ", seq=" +
            runtime.clientSeq +
            ")",
        );
      })
      .catch(function (err) {
        if (!runtime.cookieExpired) logWarn("上报播放指令失败：", err && err.message ? err.message : err);
      });
  }

  function inQuietWindow() {
    return Date.now() - runtime.lastRemoteApplyAt < REMOTE_APPLY_QUIET_MS;
  }

  // ---------------------------------------------------------- 云端心跳保活
  /**
   * 云端心跳保活（PDD §9 MVP 必做）。实测：
   * - songId 为空 → code=400 参数错误，必须带当前真实歌曲 id；
   * - 成功返回 data.timeSpan（≈30 秒），据此决定下次心跳时间。
   * 房间靠心跳续期，只轮询 sync/playlist/get 不续期（房间约 30 分钟后可能被回收）。
   */
  function sendHeartbeat(roomId, songId, playStatus, progress) {
    if (!roomId || !songId) return Promise.resolve(false);
    return postForm("/api/listen/together/heartbeat", {
      roomId: roomId,
      songId: songId,
      playStatus: playStatus,
      progress: Math.max(0, Math.round(Number(progress) || 0)),
    })
      .then(function (payload) {
        var data = payloadData(payload);
        runtime.heartbeatAt = Date.now();
        runtime.heartbeatOk += 1;
        var span = Number(data && data.timeSpan);
        if (span > 0) runtime.heartbeatIntervalMs = Math.min(120000, Math.max(5000, span * 1000));
        // 每个房间只在首次成功时记一条，避免 30s 刷屏（失败始终会告警）
        if (runtime.heartbeatOk === 1) {
          logInfo(
            "云端心跳已激活：songId=" +
              songId +
              "，下次间隔 " +
              runtime.heartbeatIntervalMs +
              "ms（房间以此续期）",
          );
        }
        return true;
      })
      .catch(function (err) {
        // 心跳失败不暂停同步：房间可能已失效，下一轮 syncCurrentRoom 会复查/切换
        if (!runtime.cookieExpired) logWarn("云端心跳失败：", err && err.message ? err.message : err);
        return false;
      });
  }

  /** 距上次心跳超过 timeSpan 时才补发；没有歌曲身份时跳过（会 400） */
  function maybeHeartbeat() {
    if (!runtime.roomId) return;
    var songId = runtime.cloudSongId || runtime.localTrackId;
    if (!songId) return;
    if (Date.now() - runtime.heartbeatAt < runtime.heartbeatIntervalMs) return;
    var progress = runtime.cloudPlaying
      ? runtime.anchorPos + (Date.now() - runtime.anchorAt)
      : runtime.anchorPos;
    sendHeartbeat(runtime.roomId, songId, runtime.cloudPlaying ? "PLAY" : "PAUSE", progress);
  }

  // -------------------------------------------------------------- 云端轮询
  /**
   * 复查云端当前房间，保证 runtime.roomId 始终指向真正在用的房间。
   * 房间被换掉/结束时必须切换或清空，否则会一直对失效房间发指令
   * （实测表现为「上报播放指令失败：云端返回 code=488」）。
   */
  function syncCurrentRoom() {
    return fetchRoomStatus()
      .then(function (status) {
        // 断网后恢复：网络失败计数归零并记一条日志（轮询本身不会中断）
        if (runtime.netErrorStreak > 0) {
          logInfo("网络已恢复，继续同步（此前连续失败 " + runtime.netErrorStreak + " 次）");
          runtime.netErrorStreak = 0;
        }
        if (status) {
          runtime.members = status.members;
          runtime.roomStatus = status.status;
        }
        var roomId = status ? status.roomId : "";
        if (!roomId) {
          if (runtime.roomId) {
            logWarn("已不在任何一起听房间，暂停同步");
            runtime.roomId = "";
            runtime.cloudSongId = "";
            runtime.members = [];
            resetRoomScopedState();
            stopPolling();
          }
          return "";
        }
        if (roomId !== runtime.roomId) {
          logInfo("检测到房间变化：" + (runtime.roomId || "(无)") + " → " + roomId);
          runtime.roomId = roomId;
          resetRoomScopedState();
          runtime.clientSeq = 0;
          runtime.selfUserId = "";
          runtime.warnedSwitch = "";
          runtime.heartbeatAt = 0; // 新房间立即补一次心跳
          runtime.heartbeatOk = 0;
          runtime.cloudSeq = -1;
          runtime.forceApplyCommand = true;
        }
        return roomId;
      })
      .catch(function (err) {
        // Cookie 失效已进入自愈流程，不重复刷网络告警
        if (runtime.cookieExpired) return null;
        runtime.netErrorStreak += 1;
        // 断网时每轮都打印会刷屏：首次与每 10 次各记一条，恢复时补一条「网络已恢复」
        if (runtime.netErrorStreak === 1 || runtime.netErrorStreak % 10 === 0) {
          logWarn(
            "读取房间状态失败（连续第 " + runtime.netErrorStreak + " 次，将自动重试）：",
            err && err.message ? err.message : err,
          );
        }
        return null;
      });
  }

  function pollOnce() {
    if (runtime.cookieExpired) return;
    syncCurrentRoom()
      .then(function (roomId) {
        if (!roomId) return undefined;
        return fetchRoomData(roomId).then(function (payload) {
          applyRoomData(payloadData(payload));
          maybeHeartbeat(); // 房间靠心跳续期；内部按 timeSpan 节流
          sampleLocalPosition();
          if (!runtime.cloudSongId) return;

          // 云端切歌 → 本地跟随：优先用 MCP 桥（宿主沙箱没有 playTrack）
          // ⚠️ 在途解除条件是「云端回声确认」，不是 POST 返回：GOTO 落库到 playCommand
          //    可读有 1~2s 延迟，POST 一返回就解除会在这个空窗把旧歌拉回来（真机实测）。
          if (runtime.pendingLocalReport) {
            if (runtime.cloudSongId && runtime.cloudSongId === runtime.pendingReportTarget) {
              runtime.pendingLocalReport = false; // 我们的 GOTO 已在云端生效
            } else if (Date.now() - runtime.pendingReportAt > 10000) {
              runtime.pendingLocalReport = false; // 兜底超时，防止卡死跟随
            } else {
              return;
            }
          }
          if (runtime.localTrackId && runtime.cloudSongId !== runtime.localTrackId) {
            if (runtime.warnedSwitch !== runtime.cloudSongId) {
              runtime.warnedSwitch = runtime.cloudSongId;
              var cfgNow = config();
              if (cfgNow.enableMcpPlay && cfgNow.mcpKey) {
                tryMcpFollowSong(runtime.cloudSongId);
              } else {
                logWarn(
                  "云端已切歌到 songId=" +
                    runtime.cloudSongId +
                    "，宿主无「按 songId 播放」接口且未启用 MCP 桥，请手动切歌。",
                );
              }
            }
            return;
          }

          // ⚠️ 只有云端发来**新指令**时才做进度 seek。
          //    同一指令下每轮都按估算进度 seek，正是「播放一段又跳回去」死循环的来源；
          //    而且 runtime.localPosition 只在播放状态事件里更新，可能偏旧，不能当基准反复纠偏。
          var applyCommand = runtime.commandIsNew || runtime.forceApplyCommand;
          runtime.forceApplyCommand = false;
          var wantPlay = runtime.cloudPlaying;
          // ⚠️ 本地播放/暂停刚变化（确认窗内）时，绝不能用云端旧的播放态强行对齐——
          //    那会把用户的暂停在 1~2s 内强行恢复、并取消挂起的 PAUSE 上报
          //    （真机实测「电脑几乎暂停不了，只成功过一次」的根因）。
          var stateAlignBlocked = localStateFresh();

          if (!applyCommand) {
            // 同一指令：只纠偏播放/暂停状态，绝不 seek
            if (runtime.localPlaying !== wantPlay && !stateAlignBlocked) {
              runtime.lastRemoteApplyAt = Date.now();
              if (wantPlay) splayer.player.play();
              else splayer.player.pause();
            }
            return;
          }

          // 新指令：先对齐播放态，再按云端 progress + serverSeq 估算位置做一次 seek
          // （暂停态同样对齐位置：对方「拖进度条后暂停」也要跟到同一位置）
          if (runtime.localPlaying !== wantPlay && !stateAlignBlocked) {
            runtime.lastRemoteApplyAt = Date.now();
            if (wantPlay) splayer.player.play();
            else splayer.player.pause();
          }

          var estimated = estimateCloudPosition();
          var drift = Math.abs(estimated - runtime.localPosition);
          if (drift > SEEK_TOLERANCE_MS) {
            runtime.lastRemoteApplyAt = Date.now();
            splayer.player.seek(estimated);
            logInfo(
              "按云端新指令对齐进度 → " +
                estimated +
                "ms（云端 " +
                runtime.cloudSongId +
                "，偏差 " +
                Math.round(drift) +
                "ms）",
            );
          }
        });
      })
      .catch(function (err) {
        if (!runtime.cookieExpired) logWarn("轮询房间状态失败：", err && err.message ? err.message : err);
      });
  }

  function startPolling() {
    if (runtime.polling) return;
    var interval = config().pollIntervalMs;
    runtime.polling = setInterval(pollOnce, interval);
    // 独立快速采样：拖进度条不产生宿主事件，靠轮询采样发现；1s 间隔压低对端对齐延迟
    if (!runtime.seekSampler) {
      runtime.seekSampler = setInterval(sampleLocalPosition, SEEK_SAMPLE_INTERVAL_MS);
    }
    logInfo("已开始云端轮询，间隔 " + interval + "ms（兼心跳保活）");
  }

  function stopPolling() {
    if (runtime.seekSampler) {
      clearInterval(runtime.seekSampler);
      runtime.seekSampler = null;
    }
    if (!runtime.polling) return;
    clearInterval(runtime.polling);
    runtime.polling = null;
    clearPendingAutoGoto(); // 离开房间后无需再等云端裁定下一首
  }

  function joinRoom(force, ignoreEnabled) {
    var cfg = config();
    if (!cfg.enableTogether && !ignoreEnabled) return Promise.resolve();
    if (!cfg.cookie) {
      logWarn("未配置网易云 Cookie，无法开始一起听");
      return Promise.resolve();
    }
    ensureDiscoveryLoop();
    runtime.cookieExpired = false;
    runtime.warnedSwitch = "";
    return discoverRoomId()
      .catch(function () {
        return "";
      })
      .then(function (discovered) {
        // 优先用云端检测到的房间；检测不到才退回手工配置的 roomId
        var roomId = discovered || cfg.roomId;
        if (!roomId) {
          logWarn("未检测到进行中的一起听房间（可在手机发起后自动接入，或手工填写房间 ID）");
          return;
        }
        if (runtime.roomId === roomId && !force) {
          startPolling();
          return;
        }
        var chain = cfg.inviterId ? acceptInvitation(roomId, cfg.inviterId) : Promise.resolve();
        return chain
          .then(function () {
            return fetchRoomData(roomId);
          })
          .then(function (payload) {
            runtime.roomId = roomId;
            resetRoomScopedState(); // 重进/换房：清掉旧会话的在途标记与冷却
            runtime.heartbeatAt = 0;
            runtime.heartbeatOk = 0;
            runtime.cloudSeq = -1;
            runtime.forceApplyCommand = true; // 首次加入后按云端进度对齐一次
            applyRoomData(payloadData(payload));
            ensureSelfUserId().catch(function () {});
            logInfo("已加入房间 " + roomId + "，云端当前歌曲 " + (runtime.cloudSongId || "未知"));
            // 立即心跳激活房间：纯 HTTP 建出的房初始为 NOT_CONNECTED，需心跳/有人加入才连上
            maybeHeartbeat();
            startPolling();
          });
      })
      .catch(function (err) {
        if (!runtime.cookieExpired) logWarn("加入房间失败：", err && err.message ? err.message : err);
      });
  }

  /** 未进房时低频自动发现：手机发起一起听后插件自动接入，无需手填房间 ID */
  function ensureDiscoveryLoop() {
    if (runtime.discovery) return;
    runtime.discovery = setInterval(function () {
      if (!config().enableTogether || runtime.roomId || runtime.cookieExpired) return;
      joinRoom(false);
    }, DISCOVERY_INTERVAL_MS);
    logInfo("已启动房间自动发现，间隔 " + DISCOVERY_INTERVAL_MS + "ms");
  }

  // -------------------------------------------------------- 本地事件 → 云端
  function onTrackChange(data) {
    var track = data && data.track ? data.track : null;
    if (!track) {
      runtime.localTrackId = "";
      return;
    }
    // 只同步网易云音源（MVP 范围：非网易云音源不同步）
    if (track.source !== "netease") {
      runtime.localTrackId = "";
      logInfo("当前音源为 " + track.source + "，非网易云，跳过一起听同步");
      return;
    }
    // 判定「自然播完」：上一首播到临近结尾才发生切歌 → 本地队列自动续播，不是用户切歌。
    // ⚠️ 必须在覆盖 runtime.localPosition/localDuration 之前取样。
    var prevTrackId = runtime.localTrackId;
    var prevPos = runtime.localPosition;
    var prevDuration = runtime.localDuration;
    var naturalEnd =
      !!prevTrackId && prevDuration > 0 && prevPos > 0 && prevPos >= prevDuration - AUTO_END_WINDOW_MS;
    clearPendingPause(); // 切歌时撤销挂起的暂停上报（过渡期的瞬时 paused）
    clearPendingAutoGoto();
    runtime.lastTrackChangeAt = Date.now(); // 过渡期内采样器不工作（位置不可信）
    var former = runtime.localTrackId || runtime.cloudSongId || String(track.id);
    runtime.localTrackId = String(track.id);
    runtime.localTrackTitle = String(track.title || "");
    runtime.localArtist = (track.artists || [])
      .map(function (a) {
        return a && a.name ? a.name : "";
      })
      .filter(Boolean)
      .join(" / ");
    runtime.localDuration = Number(track.duration || 0) || 0;
    runtime.localPlaying = true;
    runtime.localPosition = 0;
    writeSnapshot(true);

    if (!runtime.roomId || runtime.cookieExpired) return;
    // 回声判定（两条，任一命中即不上报）：
    // ① 切的就是云端当前歌 → 无需上报；
    // ② ⚠️ 切的是**我们刚 MCP 跟随过的歌** → 是跟随动作自己的回声。云端此时往往已经
    //    又前进了（跟随要 1~2s），旧判定（只比对 cloudSongId）会失效，把跟随回声当
    //    用户切歌再 ADD+GOTO，把整个房间往回拽——真机实测形成「手机前进/电脑拽回」
    //    的无限拉锯，跳歌、暂停被顶、拖进度慢全是它的症状。
    if (runtime.localTrackId === runtime.cloudSongId) return;
    if (
      runtime.localTrackId === runtime.mcpFollowedSongId &&
      Date.now() - runtime.mcpFollowedAt < 15000
    ) {
      logInfo("歌曲 " + runtime.localTrackId + " 是 MCP 跟随回声，不上报（云端已前进到 " + runtime.cloudSongId + "）");
      return;
    }
    if (naturalEnd) {
      // 本地歌曲自然播完：下一首必须由云端裁定（对方 AUTO NEXT / 房间列表）。
      // 旧实现直接 ADD+GOTO 本地队列的下一首，会把**没人选过的歌**混进两端列表，
      // 随后云端 AUTO NEXT 又切回真正的下一首 —— 真机实测「听完一首跳到别的歌再跳到下一首」。
      scheduleAutoAdvanceConfirm(former);
      return;
    }
    var roomId = runtime.roomId;
    var targetSongId = runtime.localTrackId;
    // 顺序关键：先把歌加进房间列表，再发 GOTO。
    // ⚠️ 上报在途期间必须置 pendingLocalReport：否则 ADD 的 1.2s 等待 + 轮询空窗里，
    //    轮询会看到「云端还停在自己上一首 GOTO」而发起 MCP 跟随，把用户刚切走的旧歌
    //    拉回来播——真机实测每次手动切歌都被拽回一次再跟过来（跳歌/反应不过来的真凶）。
    runtime.pendingLocalReport = true;
    runtime.pendingReportTarget = targetSongId;
    runtime.pendingReportAt = Date.now();
    ensureSongInRoomList(roomId, targetSongId)
      .catch(function (err) {
        logWarn("列表 ADD 失败（仍尝试 GOTO）：", err && err.message ? err.message : err);
        return false;
      })
      .then(function () {
        return reportGoto("GOTO", 0, "PLAY", former, targetSongId);
      });
  }

  function clearPendingAutoGoto() {
    if (runtime.pendingAutoGoto) {
      clearTimeout(runtime.pendingAutoGoto);
      runtime.pendingAutoGoto = null;
    }
    runtime.autoAdvancePending = false;
  }

  /**
   * 自然播完后的确认窗：先停住本地播放，等云端裁定。
   * ⚠️ cloudList 是 ADD 日志（哪些歌被加过），不是播放队列顺序。
   * 用 cloudList[(idx+1)] 猜下一首会导致跳歌——插件猜 D、手机走 E，冲突。
   * 正确做法：三类分支走一条路——
   * - 云端已切到别的歌 → 跟随云端（轮询 + MCP 桥会带过去）；
   * - 云端未动 → 恢复本地播放，SPlayer 自带队列自然推进下一首，
   *   onTrackChange 自动完成 ADD（如需要）+ GOTO，与手动切歌同路径；
   * - 用户确认窗内手动恢复 → 取消裁定，按正常 PLAY 走。
   */
  function scheduleAutoAdvanceConfirm(endedSongId) {
    runtime.autoAdvancePending = true;
    splayer.player.pause();
    var localNext = runtime.localTrackId;
    runtime.pendingAutoGoto = setTimeout(function () {
      runtime.pendingAutoGoto = null;
      runtime.autoAdvancePending = false;
      if (!runtime.roomId || runtime.cookieExpired) return;
      if (runtime.cloudSongId && String(runtime.cloudSongId) !== String(endedSongId)) {
        logInfo(
          "本地歌曲自然播完，云端已裁定下一首 " + runtime.cloudSongId + "，跟随云端",
        );
        return;
      }
      // 云端未推进：恢复本地播放，SPlayer 队列自然推进
      // onTrackChange 会处理 ADD（如需要）+ GOTO，与手动切歌同一路径
      logInfo("云端无下一首指令，恢复本地播放：" + localNext);
      var roomId = runtime.roomId;
      runtime.pendingLocalReport = true;
      runtime.pendingReportTarget = localNext;
      runtime.pendingReportAt = Date.now();
      ensureSongInRoomList(roomId, localNext)
        .catch(function (err) {
          logWarn("列表 ADD 失败（仍尝试 GOTO）：", err && err.message ? err.message : err);
          return false;
        })
        .then(function () {
          return reportGoto("GOTO", 0, "PLAY", endedSongId, localNext);
        })
        .then(function () {
          splayer.player.play();
        });
    }, AUTO_ADVANCE_CONFIRM_MS);
  }

  /**
   * 轮询时采样本地进度：发现同曲内大幅跳变（用户拖进度条）→ 上报 PROGRESS。
   * ⚠️ 宿主 playStateChange 只在播放/暂停切换时发事件，**拖进度条不产生任何事件**，
   * 不主动采样就无法把本地 seek 同步给对端（真机实测「电脑拖进度、手机不同步」）。
   * 手机端拖进度条下发的就是 PROGRESS 指令，这里对齐同一种编码。
   */
  function sampleLocalPosition() {
    if (!runtime.localTrackId) return;
    if (typeof splayer.player.getPosition !== "function") return;
    // ⚠️ 同步快照守卫状态：采样回调是异步的，若回调前本轮轮询的云端对齐 seek 刚设了
    // 静默窗，异步里再查 inQuietWindow() 会把自己这轮要上报的用户拖动误判成回环。
    var sampledAt = Date.now();
    var autoPendingAtSample = runtime.autoAdvancePending;
    Promise.resolve(splayer.player.getPosition())
      .then(function (pos) {
        var position = Math.max(0, Math.round(Number(pos) || 0));
        var prev = runtime.localPosition;
        runtime.localPosition = position;
        if (autoPendingAtSample || runtime.autoAdvancePending) return; // 自然播完确认窗内：跳变是我们自己暂停/续播造成的
        if (runtime.pendingLocalReport) return; // 切歌上报在途：PROGRESS 会和 GOTO 竞争（位置已记录，不丢）
        if (!runtime.roomId || runtime.cookieExpired) return;
        if (Date.now() - runtime.lastTrackChangeAt < TRACK_CHANGE_GRACE_MS) return; // 切歌过渡期位置不可信
        if (Math.abs(position - prev) < SEEK_REPORT_MIN_MS) return; // 正常播放推进
        // ⚠️ 采样开始后才落地的云端 seek（含本轮轮询自己的对齐）造成的跳变不是用户拖动。
        //    不拦住会形成「对齐 → 误报 PROGRESS → 对端再对齐」的进度互殴风暴
        //    （真机实测：每 4~5s 一条 PROGRESS，双向乱跳，PAUSE 被更新的 PROGRESS 顶掉）。
        if (inQuietWindow() || runtime.lastRemoteApplyAt > sampledAt) return;
        logInfo(
          "检测到本地进度跳变（" + Math.round(prev) + " → " + position + "ms），上报 PROGRESS 同步对端",
        );
        reportGoto(
          "PROGRESS",
          position,
          runtime.localPlaying ? "PLAY" : "PAUSE",
          runtime.localTrackId,
          runtime.localTrackId,
        );
      })
      .catch(function () {});
  }

  function clearPendingPause() {
    if (runtime.pendingPause) {
      clearTimeout(runtime.pendingPause);
      runtime.pendingPause = null;
    }
  }

  /**
   * 清空所有「绑定在某次房间会话上」的在途状态。必须在换房、重进、退房时调用，
   * 否则旧会话的残留会让新房间在最长 10s（在途超时）/30s（ADD 冷却）/15s（跟随回声）
   * 内出现跟随被阻塞、同歌无法 ADD、正常上报被抑制等怪象。
   */
  function resetRoomScopedState() {
    runtime.pendingLocalReport = false;
    runtime.pendingReportTarget = "";
    runtime.pendingReportAt = 0;
    runtime.recentAddAt = {};
    runtime.mcpFollowedSongId = "";
    runtime.mcpFollowedAt = 0;
    clearPendingPause();
    clearPendingAutoGoto();
  }

  /**
   * 延迟上报暂停：确认窗内若已恢复播放或已切歌，就**不上报**。
   *
   * ⚠️ 实测坑（2026-09-16）：宿主切歌时会在过渡期瞬时发出 stopped/paused，
   * 若照着立即上报 PAUSE，对端（手机）会被一起暂停——表现为
   * 「电脑切歌后手机有时候会暂停」。所以暂停一律延迟 PAUSE_CONFIRM_MS 确认。
   */
  function schedulePendingPause(position) {
    clearPendingPause();
    var songId = runtime.localTrackId;
    runtime.pendingPause = setTimeout(function () {
      runtime.pendingPause = null;
      if (runtime.localPlaying) return; // 已恢复播放（切歌过渡结束）
      if (runtime.localTrackId !== songId) return; // 已切到别的歌
      if (!runtime.roomId || runtime.cookieExpired || inQuietWindow()) return;
      // 暂停用独立 PAUSE 指令（QListenTogether 同款编码）：同曲 GOTO + PAUSE 会被对端当
      // 重复指令去重忽略 → 实测「电脑暂停/恢复手机不跟」
      reportGoto("PAUSE", position, "PAUSE", songId, songId);
    }, PAUSE_CONFIRM_MS);
  }

  /** 本地播放/暂停是否刚变化（还在上报确认窗内）——期间轮询对齐会吃掉用户的操作 */
  function localStateFresh() {
    return Date.now() - runtime.lastLocalStateChangeAt < LOCAL_STATE_GRACE_MS || !!runtime.pendingPause;
  }

  function onPlayStateChange(data) {
    var state = data && data.state ? data.state : "paused";
    var position = Number((data && data.position) || 0);
    var wasPlaying = runtime.localPlaying;
    runtime.localPosition = position;
    runtime.localPlaying = state === "playing";
    runtime.lastLocalStateChangeAt = Date.now();
    writeSnapshot(false);

    if (runtime.autoAdvancePending) {
      // 自然播完确认窗内的状态变化：
      // paused 是我们自己在裁定前停的 → 绝不能当用户暂停上报；
      // playing 说明用户手动恢复了本地队列 → 取消云端裁定，按用户意愿走正常恢复上报
      if (!runtime.localPlaying) return;
      clearPendingAutoGoto();
      // 落到下方正常 PLAY 上报
    }

    if (!runtime.roomId || runtime.cookieExpired) return;
    if (wasPlaying === runtime.localPlaying) return;
    if (!runtime.localTrackId) return;

    if (runtime.localPlaying) {
      // 恢复播放：撤销挂起的暂停上报并立即上报（独立 PLAY 指令，理由同 PAUSE）
      clearPendingPause();
      // ⚠️ 切歌过渡期宿主会发瞬时 paused→playing，此时的 "恢复" 不是用户操作，
      //    抢先上报的 PLAY 会和切换 GOTO 打架（真机实测同一首歌 1 秒内连发 PLAY+GOTO）
      if (Date.now() - runtime.lastTrackChangeAt < 2000) return;
      if (inQuietWindow()) return;
      reportGoto("PLAY", position, "PLAY", runtime.localTrackId, runtime.localTrackId);
      return;
    }
    schedulePendingPause(position);
  }

  // ------------------------------------------------------------ 跨端续播
  function writeSnapshot(force) {
    if (!runtime.localTrackId) return;
    var now = Date.now();
    if (!force && now - runtime.lastSnapshotAt < SNAPSHOT_WRITE_INTERVAL_MS) return;
    runtime.lastSnapshotAt = now;
    splayer.storage
      .set("snapshot", {
        songId: runtime.localTrackId,
        songName: runtime.localTrackTitle,
        artist: runtime.localArtist,
        progressMs: runtime.localPosition,
        lastUpdatedAt: now,
        isPlaying: runtime.localPlaying,
        durationMs: runtime.localDuration,
        deviceId: splayer.pluginId || "",
      })
      .catch(function () {
        /* 存储失败不影响播放 */
      });
  }

  /**
   * 跨端续播时间戳估算（PDD §7）。durationMs 已知时做越界判定：
   * 估算位置已超过歌曲总时长（离线期间这首已放完）→ 回到 0 从头播，
   * 避免 seek 到越界位置导致本地直接停播。
   */
  function estimatePosition(snapshot, now, durationMs) {
    var progress = Math.max(0, Number(snapshot.progressMs) || 0);
    var estimated = snapshot.isPlaying ? progress + (now - Number(snapshot.lastUpdatedAt || now)) : progress;
    if (estimated < 0) return 0;
    var duration = Number(durationMs) || 0;
    if (duration > 0 && estimated >= duration) return 0;
    return estimated;
  }

  function resumeFromSnapshot() {
    var cfg = config();
    if (!cfg.enableAutoResume) return;
    splayer.storage
      .get("snapshot")
      .then(function (snapshot) {
        if (!snapshot || !snapshot.songId) return;
        if (runtime.localTrackId && String(snapshot.songId) !== runtime.localTrackId) {
          // ⚠️ 降级 1 的直接后果：无法切到快照歌曲，只能恢复播放态
          logWarn(
            "快照歌曲 songId=" +
              snapshot.songId +
              " 与当前曲目不一致，宿主不支持按 songId 播放，无法自动续播到该歌曲。",
          );
          return;
        }
        // 时长优先用快照记录值（离线期间已放完 → 回 0）；旧快照缺该字段时退回当前曲目时长
        var target = estimatePosition(snapshot, Date.now(), Number(snapshot.durationMs) || runtime.localDuration);
        runtime.lastRemoteApplyAt = Date.now();
        splayer.player.play();
        splayer.player.seek(target);
        if (snapshot.isPlaying === false) splayer.player.pause();
        logInfo("已按快照恢复播放位置 " + target + "ms");
      })
      .catch(function (err) {
        logWarn("读取快照失败：", err && err.message ? err.message : err);
      });
  }

  // ------------------------------------------------------------ MCP 桥（替代方案）
  /**
   * 上游插件 API 没有 player.playTrack（见 docs/upstream/player-playTrack.md），
   * 这里用本机 MCP（Streamable HTTP）的 play_track 作为替代，让「云端切歌 → 本地跟随」可用。
   * 设置项：enableMcpPlay / mcpPort / mcpKey（对应 settings.json 的 mcp.port / mcp.accessKey）。
   * 已实测跑通：initialize 取响应头 mcp-session-id → notifications/initialized → tools/call play_track。
   */
  var mcpState = { sessionId: "", seq: 0 };

  /** 响应可能是 JSON，也可能是 SSE（text/event-stream） */
  function parseMcpBody(res) {
    var body = res ? res.body : null;
    var text = typeof body === "string" ? body : JSON.stringify(body || "");
    if (text.indexOf("data:") >= 0) {
      var last = null;
      text.split(/\r?\n\r?\n/).forEach(function (chunk) {
        var lines = chunk
          .split(/\r?\n/)
          .filter(function (line) {
            return line.indexOf("data:") === 0;
          })
          .map(function (line) {
            return line.slice(5).trim();
          });
        if (lines.length) {
          try {
            last = JSON.parse(lines.join("\n"));
          } catch (e) {
            /* 忽略非 JSON 的 SSE 片段 */
          }
        }
      });
      return last;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function mcpRpc(method, params, isNotification) {
    var cfg = config();
    if (!cfg.mcpKey) return Promise.reject(new Error("未配置 MCP Key"));
    var message = isNotification
      ? { jsonrpc: "2.0", method: method, params: params }
      : { jsonrpc: "2.0", id: ++mcpState.seq, method: method, params: params };
    var headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-mcp-key": cfg.mcpKey,
    };
    if (mcpState.sessionId) headers["mcp-session-id"] = mcpState.sessionId;
    return splayer
      .request("http://127.0.0.1:" + cfg.mcpPort + "/mcp", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(message),
        responseType: "text",
      })
      .then(function (res) {
        if (!res || (typeof res.status === "number" && res.status >= 400)) {
          mcpState.sessionId = ""; // 会话可能失效，下次重建
          throw new Error("MCP HTTP " + (res ? res.status : "no-response"));
        }
        var h = res.headers || {};
        var sid = h["mcp-session-id"] || h["MCP-Session-Id"];
        if (sid) mcpState.sessionId = sid;
        return isNotification ? null : parseMcpBody(res);
      });
  }

  function mcpEnsureSession() {
    if (mcpState.sessionId) return Promise.resolve(true);
    return mcpRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "splayer-together", version: "0.1.0" },
    })
      .then(function () {
        return mcpRpc("notifications/initialized", {}, true);
      })
      .then(function () {
        return true;
      });
  }

  function mcpCallTool(name, args) {
    return mcpEnsureSession()
      .then(function () {
        return mcpRpc("tools/call", { name: name, arguments: args || {} });
      })
      .then(function (json) {
        if (json && json.error) throw new Error(json.error.message || "MCP error");
        var content = (json && json.result && json.result.content) || [];
        return content.length ? String(content[0].text || "") : "";
      });
  }

  /** 取歌曲详情，构造 play_track 需要的 Track（网易云字段 ar/al/dt） */
  function fetchSongTrack(songId) {
    var id = String(songId);
    return postForm(
      "/api/v3/song/detail",
      {
        c: JSON.stringify([{ id: Number(id) || id }]),
        ids: JSON.stringify([id]),
      },
      { retries: REQUEST_RETRIES },
    ).then(function (payload) {
      var data = payloadData(payload);
      var song = (data.songs || [])[0];
      if (!song) throw new Error("未取到歌曲详情");
      return {
        id: String(song.id || id),
        source: "netease",
        title: String(song.name || ""),
        artists: (song.ar || song.artists || []).map(function (a) {
          return { id: a.id, name: a.name };
        }),
        album: song.al ? { id: song.al.id, name: song.al.name, cover: song.al.picUrl } : undefined,
        duration: Number(song.dt || song.duration || 0),
      };
    });
  }

  /** 云端切歌后，用 MCP 的 play_track 让本地跟随 */
  function tryMcpFollowSong(songId) {
    runtime.lastRemoteApplyAt = Date.now(); // 属于"云端指令落地"，抑制回环上报
    runtime.mcpFollowedSongId = String(songId);
    runtime.mcpFollowedAt = Date.now();
    return fetchSongTrack(songId)
      .catch(function () {
        return { id: String(songId), source: "netease" }; // 详情失败也尽力一试
      })
      .then(function (track) {
        return mcpCallTool("play_track", { track: track });
      })
      .then(function (text) {
        logInfo("已通过 MCP 桥切到云端歌曲 songId=" + songId + " → " + String(text).slice(0, 80));
        return true;
      })
      .catch(function (err) {
        logWarn("MCP 桥切歌失败，回退为手动切歌：", err && err.message ? err.message : err);
        return false;
      });
  }

  // ------------------------------------------------ Cookie 来源（本机桥接）
  /**
   * 启动时载入插件缓存的登录 Cookie（由本机桥接脚本写入，或上一次会话留下）。
   * 宿主沙箱读不到 SPlayer 已登录的网易云会话（没有 fs/账号 API，外部 API 与 MCP 也不提供），
   * 因此 Cookie 只能由 tools/cookie-bridge.mjs 通过 127.0.0.1 提供，插件读取后缓存复用。
   */
  function loadAutoCookie() {
    return splayer.storage
      .get("autoCookie")
      .then(function (value) {
        runtime.autoCookie = value ? String(value) : "";
        if (runtime.autoCookie) {
          logInfo("已载入缓存的网易云登录 Cookie（来自本机桥接）");
        }
      })
      .catch(function () {
        runtime.autoCookie = "";
      });
  }

  /**
   * 从本机桥接脚本读取 SPlayer 已登录的网易云 Cookie。
   * 桥接脚本见 tools/cookie-bridge.mjs（只读 library.db 的 account_sessions，经 127.0.0.1 提供）。
   * 未运行脚本时静默失败（连接被拒），返回空串。
   */
  function fetchBridgeCookie() {
    var port = Number(setting("cookieBridgePort", COOKIE_BRIDGE_PORT));
    if (!port || port <= 0) return Promise.resolve("");
    return splayer
      .request("http://127.0.0.1:" + port + "/cookie", {
        method: "GET",
        timeout: 2500,
        responseType: "json",
      })
      .then(function (res) {
        if (!res || (typeof res.status === "number" && res.status >= 400)) return "";
        var body = res.body || {};
        var cookie = body && body.cookie ? String(body.cookie) : "";
        return cookie && cookie.indexOf("MUSIC_U=") >= 0 ? cookie : "";
      })
      .catch(function () {
        return "";
      });
  }

  /**
   * 刷新并采用桥接 Cookie（成功即替换运行时 Cookie，并持久化到 autoCookie）。
   * @returns {Promise<{ok:boolean, changed:boolean}>} ok 是否取到；changed 生效中的 Cookie 是否变化
   */
  function refreshCookieFromBridge() {
    var before = config().cookie;
    return fetchBridgeCookie().then(function (cookie) {
      if (!cookie) return { ok: false, changed: false };
      runtime.bridgeCookie = cookie;
      splayer.storage.set("autoCookie", cookie).catch(function () {
        /* 存储失败不影响本次会话使用 */
      });
      var changed = config().cookie !== before;
      if (changed) logInfo("已从本机 SPlayer 登录会话同步 Cookie（桥接脚本）");
      return { ok: true, changed: changed };
    });
  }

  /**
   * 菜单动作：从本机 SPlayer 登录会话刷新 Cookie（桥接脚本）。
   * 桥接脚本关闭或未运行时给出可操作的提示，不静默失败。
   */
  function actionBridgeCookie() {
    var port = Number(setting("cookieBridgePort", COOKIE_BRIDGE_PORT));
    if (!port || port <= 0) {
      return Promise.resolve({ toast: "已在设置中关闭本机 Cookie 桥接（端口填 0）" });
    }
    return refreshCookieFromBridge().then(function (res) {
      if (!res.ok) {
        return {
          toast:
            "未连上本机 Cookie 桥接（127.0.0.1:" +
            port +
            "）。请先运行 tools/cookie-bridge.mjs（或 start-cookie-bridge.bat）再点此菜单",
        };
      }
      runtime.cookieExpired = false;
      runtime.selfUserId = "";
      clearCookieRetry();
      joinRoom(true);
      return {
        toast: res.changed
          ? "已从本机 SPlayer 登录会话同步 Cookie，并开始同步"
          : "本机 SPlayer 登录 Cookie 无变化（已是最新）",
      };
    });
  }

  /** 菜单动作：Cookie 状态（来源 / 是否含必需字段 / 当前是否可用） */
  function actionCookieStatus() {
    var manual = String(setting("neteaseCookie", ""));
    var auto = runtime.autoCookie;
    var bridge = runtime.bridgeCookie;
    var active = bridge || manual || auto;
    if (!active) {
      return Promise.resolve({ toast: "未配置 Cookie；可在设置里手工粘贴，或运行本机 Cookie 桥接后点「从本机登录会话同步 Cookie」" });
    }
    var source = bridge ? "本机 SPlayer 登录会话（桥接）" : manual ? "设置项手工填写" : "插件缓存的登录 Cookie";
    var flags =
      "MUSIC_U " +
      (active.indexOf("MUSIC_U=") >= 0 ? "✓" : "✗") +
      "，__csrf " +
      (active.indexOf("__csrf=") >= 0 ? "✓" : "✗");
    return fetchRoomStatus()
      .then(function () {
        return {
          toast: "Cookie 有效（来源：" + source + "；" + flags + "）；当前房间：" + (runtime.roomId || "无"),
        };
      })
      .catch(function (err) {
        return {
          toast:
            "Cookie 可能已失效（来源：" +
            source +
            "；" +
            flags +
            "）：" +
            (err && err.message ? err.message : err) +
            "；请检查设置里的手工 Cookie 是否过期，或确认本机 Cookie 桥接正在运行",
        };
      });
  }

  // ------------------------------------------------------------ 歌曲菜单动作
  /** 菜单动作：在电脑端建房，并按配置邀请指定 userId */
  function actionCreateRoomAndInvite() {
    var cfg = config();
    if (!cfg.cookie) return Promise.resolve({ toast: "请先在插件设置里填写网易云 Cookie" });
    return discoverRoomId()
      .catch(function () {
        return "";
      })
      .then(function (existing) {
        if (existing) return { roomId: existing, creatorId: runtime.selfUserId || "", created: false };
        return createRoom().then(function (created) {
          return { roomId: created.roomId, creatorId: created.creatorId, created: true };
        });
      })
      .then(function (res) {
        var roomId = res.roomId;
        runtime.cookieExpired = false;
        var inviteStep = cfg.inviteeUserId
          ? inviteToRoom(roomId, cfg.inviteeUserId).catch(function () {
              return false;
            })
          : Promise.resolve(false);
        return inviteStep.then(function (invited) {
          return joinRoom(true, true).then(function () {
            // 官方分享链接（参考 QListenTogether Main.qml）
            // https://st.music.163.com/listen-together/share/?songId=<id>&roomId=<roomId>&inviterId=<creatorId>
            var shareUrl =
              "https://st.music.163.com/listen-together/share/?songId=" +
              (runtime.localTrackId || runtime.cloudSongId || "") +
              "&roomId=" +
              roomId +
              "&inviterId=" +
              (res.creatorId || runtime.selfUserId || "");
            var toast =
              (res.created ? "已在电脑端建房：" : "已在房间：") +
              roomId +
              (cfg.inviteeUserId
                ? invited
                  ? "，已向 " + cfg.inviteeUserId + " 发送原生邀请"
                  : "，原生邀请发送失败"
                : "") +
              "；分享链接已复制，发到手机打开即可加入" +
              (res.created
                ? "。⚠️ 新房初始为「未连接(NOT_CONNECTED)」，对方加入后才转为已连接；若对方 App 打不开链接，可让对方用手机发起一起听，本插件会自动接入"
                : "");
            logInfo(toast + " 链接: " + shareUrl);
            return { toast: toast, copyText: shareUrl };
          });
        });
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        logWarn("建房/邀请失败：", msg);
        return { toast: "建房/邀请失败：" + msg };
      });
  }

  /** 菜单动作：查看房间成员与云端当前歌曲（成员取 roomInfo.roomUsers，不用会漏人的 playlist.version） */
  function actionDescribeRoom() {
    return fetchRoomStatus()
      .catch(function () {
        return null;
      })
      .then(function (status) {
        var roomId = (status && status.roomId) || runtime.roomId;
        if (!roomId) return { toast: "当前不在任何一起听房间" };
        if (status) runtime.members = status.members;
        return fetchRoomData(roomId).then(function (payload) {
          applyRoomData(payloadData(payload));
          var text =
            "房间 " +
            roomId +
            "；状态 " +
            (runtime.roomStatus || "未知") +
            "；成员 " +
            runtime.members.length +
            " 人：" +
            (describeMembers() || "未知") +
            "；云端歌曲：" +
            (runtime.cloudSongId || "未知");
          if (runtime.roomStatus === "NOT_CONNECTED") {
            text += "（尚无官方客户端接入，对方此时可能打不开分享链接）";
          }
          return { toast: text };
        });
      })
      .catch(function (err) {
        return { toast: "读取房间失败：" + (err && err.message ? err.message : err) };
      });
  }

  /**
   * 菜单动作：把房间列表 REPLACE 为当前歌，清掉历史累积/重复项。
   * 场景：旧版本解析 bug 曾把列表灌到 35+ 首重复项，两端「下一首」因此混乱；
   * REPLACE 是官方语义（QListenTogether 建房即用），重置后两端列表从当前歌起重新收敛。
   */
  function actionResetRoomList() {
    var roomId = runtime.roomId;
    var currentSong = runtime.cloudSongId || runtime.localTrackId;
    if (!roomId) return Promise.resolve({ toast: "当前不在任何一起听房间" });
    if (!currentSong) return Promise.resolve({ toast: "当前没有歌曲身份，无法重置列表" });
    return ensureSelfUserId()
      .then(function (myId) {
        return fetchRoomData(roomId).then(function (payload) {
          var playlist = payloadData(payload).playlist || {};
          return postForm("/api/listen/together/sync/list/command/report", {
            roomId: roomId,
            playlistParam: JSON.stringify({
              commandType: "REPLACE",
              version: bumpVersion(playlist.version || [], myId),
              playMode: "ORDER_LOOP",
              anchorSongId: currentSong,
              anchorPosition: 0,
              randomList: [currentSong],
              displayList: [currentSong],
            }),
          }).then(function () {
            runtime.cloudList = [String(currentSong)];
            runtime.recentAddAt = {};
            logInfo("已 REPLACE 重置房间列表为当前歌 " + currentSong);
            return { toast: "房间列表已重置为当前歌，两端将重新收敛" };
          });
        });
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        logWarn("重置房间列表失败：", msg);
        return { toast: "重置失败：" + msg };
      });
  }

  function actionLeaveRoom() {
    var cfg = config();
    if (!cfg.cookie) return Promise.resolve({ toast: "请先填写网易云 Cookie" });
    return discoverRoomId()
      .catch(function () {
        return runtime.roomId;
      })
      .then(function (discovered) {
        var roomId = discovered || runtime.roomId;
        if (!roomId) {
          runtime.roomId = "";
          stopPolling();
          return { toast: "当前不在任何一起听房间" };
        }
        return postForm("/api/listen/together/end/v2", { roomId: roomId }).then(function () {
          logInfo("已退出一起听房间 " + roomId);
          runtime.roomId = "";
          runtime.cloudSongId = "";
          runtime.cloudPlaying = false;
          runtime.clientSeq = 0;
          runtime.warnedSwitch = "";
          resetRoomScopedState();
          stopPolling();
          return { toast: "已退出一起听：" + roomId };
        });
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        logWarn("退出一起听失败：", msg);
        return { toast: "退出失败：" + msg };
      });
  }

  /**
   * 拉取我关注的人（含 userId/nickname）。实测 POST /api/user/getfollows/<uid> 明文可用，
   * 且为**顶层返回**（无 data 包裹）。
   * ⚠️ 宿主不足以做常驻界面：设置项是静态声明无法动态填充下拉，也没有列表 UI，
   *    所以「好友名单」只能靠菜单返回 toast / copyText，并把全量写进日志。
   */
  function fetchFollows() {
    return ensureSelfUserId().then(function (uid) {
      if (!uid) throw new Error("未取到自身 userId");
      return postForm(
        "/api/user/getfollows/" + uid,
        { offset: 0, limit: 100, order: true },
        { retries: REQUEST_RETRIES },
      ).then(function (payload) {
        return payloadData(payload).follow || [];
      });
    });
  }

  /** 好友按「昵称(userId)」逐行格式化，便于人眼对照 id 与名称 */
  function formatFriendLines(list) {
    return list.map(function (u) {
      return (u.nickname || "(无昵称)") + "(" + u.userId + ")";
    });
  }

  /**
   * 菜单动作：好友名单（昵称 ↔ userId 对照）。
   * toast 展示前 20 行（宿主可能截断长文本），完整名单同时写入日志，
   * copyText 给出完整对照文本，粘到任意输入框/记事本即可查看全部。
   */
  function actionListFriends() {
    var cfg = config();
    if (!cfg.cookie) return Promise.resolve({ toast: "请先填写网易云 Cookie" });
    return fetchFollows()
      .then(function (list) {
        if (!list.length) return { toast: "没有拉到关注列表（可能未关注任何人）" };
        var lines = formatFriendLines(list);
        logInfo("关注列表共 " + list.length + " 人（昵称↔userId 对照）：\n" + lines.join("\n"));
        // ⚠️ 宿主 toast 是**单行**展示：多行文本会被拼成一长行并溢出界面。
        //    所以 toast 只给一行摘要，完整对照走剪贴板（copyText）。
        return {
          toast: "关注 " + list.length + " 人；完整「昵称(userId)」对照（" + lines.length + " 行）已复制到剪贴板",
          copyText: lines.join("\n"),
        };
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        return { toast: "拉取好友失败：" + msg };
      });
  }

  /** 菜单动作：只复制好友 userId（逗号分隔），便于直接粘进「邀请对象 userId」 */
  function actionCopyFriendIds() {
    var cfg = config();
    if (!cfg.cookie) return Promise.resolve({ toast: "请先填写网易云 Cookie" });
    return fetchFollows()
      .then(function (list) {
        if (!list.length) return { toast: "没有拉到关注列表（可能未关注任何人）" };
        var ids = list
          .map(function (u) {
            return u.userId;
          })
          .join(",");
        logInfo("已导出 " + list.length + " 个好友 userId（逗号分隔）");
        return { toast: "已复制 " + list.length + " 个好友 userId，可直接粘到「邀请对象 userId」", copyText: ids };
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        return { toast: "拉取好友失败：" + msg };
      });
  }

  /** 菜单动作：MCP 桥自检（建会话 + tools/list，确认 play_track 可用） */
  function actionMcpCheck() {
    var cfg = config();
    if (!cfg.mcpKey) return Promise.resolve({ toast: "未配置 MCP Key（端口默认 14559，Key 见 settings.json 的 mcp.accessKey）" });
    mcpState.sessionId = "";
    return mcpEnsureSession()
      .then(function () {
        return mcpRpc("tools/list", {});
      })
      .then(function (json) {
        var tools = (json && json.result && json.result.tools) || [];
        var has = tools.some(function (t) {
          return t.name === "play_track";
        });
        return { toast: "MCP 桥正常：会话已建立，工具 " + tools.length + " 个，play_track " + (has ? "可用" : "缺失") };
      })
      .catch(function (err) {
        return { toast: "MCP 桥不可用：" + (err && err.message ? err.message : err) };
      });
  }

  // ---------------------------------------------------------------- 注册
  splayer.register({
    events: ["trackChange", "playStateChange"],
    controls: true,
    // 菜单项需 @grant ui；会出现在歌曲「更多」菜单与列表右键菜单（同插件的项折叠在一个子菜单下）
    menus: [
      { id: "create-room", label: "一起听：在电脑端建房并邀请" },
      { id: "cookie-status", label: "一起听：Cookie 状态" },
      { id: "bridge-cookie", label: "一起听：从本机登录会话同步 Cookie" },
      { id: "room-status", label: "一起听：查看房间成员" },
      { id: "list-friends", label: "一起听：好友名单（昵称↔ID 对照）" },
      { id: "friend-ids", label: "一起听：复制好友 userId（邀请用）" },
      { id: "leave-room", label: "一起听：退出/结束房间" },
      { id: "reset-list", label: "一起听：重置房间列表为当前歌（清历史重复）" },
      { id: "mcp-check", label: "一起听：MCP 桥自检" },
    ],
    settings: [
      {
        key: "neteaseCookie",
        type: "text",
        label: "网易云 Cookie",
        default: "",
        description: "需包含 MUSIC_U 与 __csrf；手工填写时优先于桥接/缓存；日志不会打印完整值",
      },
      {
        key: "enableTogetherListen",
        type: "switch",
        label: "启用一起听",
        default: false,
        description: "自动发现并接入当前一起听房间；房间需有活跃播放终端维持",
      },
      {
        key: "roomId",
        type: "text",
        label: "房间 ID（可留空）",
        default: "",
        description: "留空则自动发现当前房间（推荐）；仅当自动发现不可用时才需手工填写",
      },
      {
        key: "inviterId",
        type: "text",
        label: "邀请人 ID（可留空）",
        default: "",
        description: "已是房间成员时留空；只有需要接受他人邀请时才填写",
      },
      {
        key: "inviteeUserId",
        type: "text",
        label: "邀请对象 userId（电脑端建房用）",
        default: "",
        description: "在电脑端建房时邀请这个网易云数字 userId；对方手机端会收到原生一起听邀请",
      },
      {
        key: "enableAutoResume",
        type: "switch",
        label: "启用跨端续播",
        default: true,
        description: "插件启用时按上次快照估算进度（快照歌曲与当前曲目一致时才 seek）",
      },
      {
        key: "pollIntervalMs",
        type: "number",
        label: "轮询间隔(毫秒)",
        default: DEFAULT_POLL_INTERVAL_MS,
        min: 2000,
        max: 60000,
        description: "轮询云端房间状态，兼作心跳保活",
      },
      {
        key: "apiBaseUrl",
        type: "text",
        label: "云端 API 基址",
        default: DEFAULT_API_BASE,
        description: "默认官方 music.163.com；可改为自建 api-enhanced 地址",
      },
      {
        key: "enableMcpPlay",
        type: "switch",
        label: "云端切歌用 MCP 桥跟随",
        default: true,
        description: "上游插件 API 没有 playTrack；开启后用本机 MCP 的 play_track 让本地跟随云端切歌（需填 MCP 端口与 Key）",
      },
      { key: "mcpPort", type: "number", label: "MCP 端口", default: 14559, min: 1024, max: 65535 },
      {
        key: "mcpKey",
        type: "text",
        label: "MCP 访问密钥 (x-mcp-key)",
        default: "",
        description: "见 settings.json 的 mcp.accessKey；用于调用本机 MCP 的 play_track",
      },
      {
        key: "cookieBridgePort",
        type: "number",
        label: "本机 Cookie 桥接端口",
        default: COOKIE_BRIDGE_PORT,
        min: 0,
        max: 65535,
        description:
          "配合 tools/cookie-bridge.mjs：自动读取 SPlayer 已登录的网易云 Cookie（填 0 关闭）。优先于手工 Cookie",
      },
    ],
  });

  splayer.player.on("trackChange", onTrackChange);
  splayer.player.on("playStateChange", onPlayStateChange);
  splayer.onSettingChange("enableTogetherListen", function () {
    runtime.cookieExpired = false;
    if (config().enableTogetherListen) {
      joinRoom(true);
    } else {
      // ⚠️ 关闭开关必须真的停掉轮询：旧行为只处理开启分支，关闭后插件仍在同步
      stopPolling();
      clearCookieRetry();
      logInfo("一起听已关闭，停止云端轮询");
    }
  });
  splayer.onSettingChange("roomId", function () {
    joinRoom(true);
  });
  splayer.onSettingChange("neteaseCookie", function () {
    runtime.cookieExpired = false;
    runtime.selfUserId = "";
    clearCookieRetry();
    joinRoom(true);
  });

  // 歌曲菜单点击：这是 control 插件唯一能加的界面入口（无法注入 App 原生底栏按钮）
  splayer.on("menuClick", function (req) {
    var menuId = req && req.menuId;
    if (menuId === "create-room") return actionCreateRoomAndInvite();
    if (menuId === "cookie-status") return actionCookieStatus();
    if (menuId === "bridge-cookie") return actionBridgeCookie();
    if (menuId === "room-status") return actionDescribeRoom();
    if (menuId === "list-friends") return actionListFriends();
    if (menuId === "friend-ids") return actionCopyFriendIds();
    if (menuId === "leave-room") return actionLeaveRoom();
    if (menuId === "reset-list") return actionResetRoomList();
    if (menuId === "mcp-check") return actionMcpCheck();
    return undefined;
  });

  // 启动：先载入缓存的登录 Cookie（异步），再续播并按配置加入房间。
  // 必须先载入，否则设置项为空时 joinRoom 会误判「未配置 Cookie」。
  loadAutoCookie().then(function () {
    resumeFromSnapshot();
    joinRoom(false);
    // 后台尝试从本机桥接脚本拉取 SPlayer 已登录 Cookie（脚本未运行则静默失败）。
    // 用「后台」而非阻塞启动：没有脚本的用户不受影响，有脚本的用户 Cookie 始终最新。
    refreshCookieFromBridge().then(function (res) {
      if (res.ok && res.changed) {
        runtime.cookieExpired = false;
        clearCookieRetry();
        joinRoom(true);
      }
    });
  });
})();

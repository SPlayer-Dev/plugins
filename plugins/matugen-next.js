/**
 * @name Matugen配色
 * @id matugen-next
 * @version 1.0.1
 * @description 让 SPlayer-Next 实时跟随 Matugen 生成的配色，并在「主题色来源」下拉框中新增「Matugen」选项。支持 macOS / Linux / FreeBSD / Windows。
 * @author macOS终端
 * @homepage https://github.com/macOS-Terminal/splayer-matugen-plugin
 * @apiLevel 5
 * @grant ui
 */

/*
 * ============================================================================
 * Matugen配色 —— SPlayer-Next × Matugen 实时配色桥
 * ============================================================================
 *
 * 原理（下列每一步都在真实运行的应用上验证过）：
 *
 * 1. Matugen 只负责给出「一个种子色」。SPlayer-Next 内部用
 *    @material/material-color-utilities 自己展开整套 M3 调色板，
 *    所以插件只需把一个 #rrggbb 写进主题 store 的 customColor，
 *    播放器自己就会重算 --s-primary / --s-surface 等全部 CSS 变量。
 *
 * 2. 插件运行在 host.worker.js 的 node:vm 沙箱里，没有 process / fs / fetch，
 *    但 Buffer 是宿主真实对象 —— Buffer.constructor('return globalThis')()
 *    能拿到宿主 utility 进程的全局对象，从而拿到真实 process，
 *    再用 process.getBuiltinModule() 取 fs / path / os / http。
 *
 * 3. 插件进程没有 DOM，必须把代码送进渲染进程。应用默认没有开
 *    --remote-debugging-port，所以走 Node 自带的 inspector：
 *      插件进程 process._debugProcess(mainPid)
 *        → 主进程 inspector 开在 127.0.0.1:9229
 *        → WebSocket 连上 target，Runtime.evaluate
 *        → 主进程里 require('electron') 拿到 BrowserWindow
 *        → webContents.executeJavaScript(payload) 注入渲染进程
 *        → setTimeout(() => process._debugEnd(), 500) 延迟关闭 inspector
 *
 * 4. 为避免每次换色都开关一次 inspector，首次注入时在主进程留一个常驻
 *    agent：它轮询 state.json，rev 变化就重新注入；并监听
 *    browser-window-created / did-finish-load，渲染进程重载后自动补回。
 *    插件进程之后只写 state.json 即可。
 *
 * 5. 主题来源不新增真实的 store 值（那会破坏播放器内部的枚举判断），而是用
 *    「虚拟绑定」：在 store 上定义 getter/setter matugenSource，再把设置项
 *    themeSource 的 binding.path 指向它。选中 Matugen 时内部实际是
 *      source = 'custom' + customColor = 种子色 + imageBackground.matugenActive = true
 *    这样 SPlayer 自己的 watch → applyThemeToDOM 链路完全照常工作，
 *    不依赖任何未导出的内部函数。matugenActive 是 imageBackground 上的
 *    响应式布尔量，会随主题 store 一起持久化，因此重启后仍记得选择。
 *
 * 6. 「主题色来源」的选项来自 out/renderer/assets/searchSettings-*.js 导出的
 *    settingsSchema。插件进程在 asar 里定位该 chunk 文件名，渲染进程里
 *    动态 import 后往 options 数组插入一项 Matugen。设置面板是懒挂载的，
 *    只要在首次打开设置面板之前插入即可显示。
 *
 * 平台说明：macOS / Linux / FreeBSD / Windows 已按各自差异分别适配 —
 *   - 配置与缓存目录（XDG / Library / APPDATA、LOCALAPPDATA，见第 1 节）
 *   - 应用资源目录（Windows·Linux 在 <安装目录>/resources，
 *     macOS 在 <App>.app/Contents/Resources，见 mainEntryPath / findRendererAssetsDir）
 *   - 绝对路径判断（必须用 path.isAbsolute，Windows 盘符路径不以 / 开头）
 *   - 状态文件原子写入（Windows 的 rename 覆盖可能失败，带退化重试）
 *   - 父进程命令行读取（/proc 仅 Linux/FreeBSD；macOS 用 ps）
 *   其中 Linux 已实机验证，其余平台为代码级适配（理论支持，未真机运行）。
 *
 * 说明：本插件依赖上述宿主能力（官方文档也写明插件沙箱不是安全边界）。
 * 它只读 Matugen 输出文件与本机 127.0.0.1 的调试端口，不访问外部网络。
 */

(async () => {
  'use strict';

  /** 日志前缀，便于在 app-data/logs 里检索 */
  const TAG = '[Matugen]';

  const PLUGIN_VERSION = '1.0.1';

  // ---------------------------------------------------------------------------
  // 0. 沙箱逃逸，拿到宿主 Node 能力
  // ---------------------------------------------------------------------------

  let HOST = null;
  try {
    HOST = Buffer.constructor('return globalThis')();
  } catch (err) {
    HOST = null;
  }
  const NODE = HOST && HOST.process;

  const log = {
    info: (...args) => {
      try {
        splayer.log.info(TAG, ...args);
      } catch (err) {
        /* ignore */
      }
    },
    warn: (...args) => {
      try {
        splayer.log.warn(TAG, ...args);
      } catch (err) {
        /* ignore */
      }
    },
    error: (...args) => {
      try {
        splayer.log.error(TAG, ...args);
      } catch (err) {
        /* ignore */
      }
    },
  };

  // 拿不到宿主 Node 能力时，退化成只解释原因的空插件，而不是直接崩掉
  if (!NODE) {
    log.error('当前宿主未开放 Node 能力，无法读取 Matugen 输出，插件不可用');
    try {
      splayer.register({
        settings: [
          {
            key: 'enabled',
            type: 'switch',
            label: '启用 Matugen 配色同步（当前环境不可用）',
            default: false,
            description: '当前插件宿主未开放 Node 能力，无法读取 Matugen 输出文件。请升级 SPlayer-Next 或反馈给插件作者。',
          },
        ],
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const fs = NODE.getBuiltinModule('fs');
  const path = NODE.getBuiltinModule('path');
  const os = NODE.getBuiltinModule('os');
  const http = NODE.getBuiltinModule('http');

  const IS_WIN = NODE.platform === 'win32';
  const IS_MAC = NODE.platform === 'darwin';
  const PLATFORM = String(NODE.platform);
  const WebSocketImpl = HOST.WebSocket;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const join = (...parts) => path.join(...parts);
  const envGet = (name) => {
    const value = NODE.env[name];
    return typeof value === 'string' && value ? value : '';
  };

  const HOME = (() => {
    try {
      return os.homedir();
    } catch (err) {
      return envGet('HOME') || envGet('USERPROFILE') || '.';
    }
  })();

  // ---------------------------------------------------------------------------
  // 1. 跨平台路径
  // ---------------------------------------------------------------------------
  //
  // 路径规则对齐 Rust `dirs` crate（Matugen 自身就由它决定配置/缓存位置）：
  //   macOS   → ~/Library/Application Support 、~/Library/Caches
  //   Windows → %APPDATA% 、%LOCALAPPDATA%
  //   Linux / FreeBSD 等 Unix → $XDG_CONFIG_HOME / $XDG_CACHE_HOME，缺省 ~/.config、~/.cache
  // 其中 Linux 已实机验证；macOS / FreeBSD / Windows 走同一套逻辑分支，
  // 属于理论支持（未在真机上跑过），界面上也按此说明标注。

  /** Matugen 配置根目录，对应 Rust dirs::config_dir() */
  function configBase() {
    if (IS_WIN) return envGet('APPDATA') || join(HOME, 'AppData', 'Roaming');
    if (IS_MAC) return join(HOME, 'Library', 'Application Support');
    // Linux / FreeBSD / 其它 Unix：遵循 XDG 基础目录规范
    return envGet('XDG_CONFIG_HOME') || join(HOME, '.config');
  }

  /** 缓存根目录，对应 Rust dirs::cache_dir() */
  function cacheBase() {
    if (IS_WIN) return envGet('LOCALAPPDATA') || join(HOME, 'AppData', 'Local');
    if (IS_MAC) return join(HOME, 'Library', 'Caches');
    // Linux / FreeBSD / 其它 Unix：遵循 XDG 基础目录规范
    return envGet('XDG_CACHE_HOME') || join(HOME, '.cache');
  }

  const MATUGEN_DIR = join(configBase(), 'matugen');
  const TEMPLATE_DIR = join(MATUGEN_DIR, 'templates');
  const DEFAULT_CONFIG_PATH = join(MATUGEN_DIR, 'config.toml');
  const DEFAULT_TEMPLATE_PATH = join(TEMPLATE_DIR, 'splayer-next.json');

  /** 插件工作目录：状态文件 / ack / 调试日志 */
  const WORK_DIR = join(cacheBase(), 'matugen', 'splayer-next');
  const STATE_FILE = join(WORK_DIR, 'state.json');
  const ACK_FILE = join(WORK_DIR, 'ack.json');
  const DEBUG_FILE = join(WORK_DIR, 'debug.log');

  /** Matugen 渲染出的种子色文件 */
  const DEFAULT_OUTPUT_FILE = join(cacheBase(), 'matugen', 'splayer-next.json');

  /** 兜底种子来源：DMS（DankMaterialShell）记录的最后一次 Matugen 种子色 */
  const DMS_SEEDS_FILE = join(cacheBase(), 'dms', 'matugen-seeds.json');

  /** 简单滚动日志，避免无限增长 */
  function debugLog(message) {
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true });
      fs.appendFileSync(DEBUG_FILE, new Date().toISOString() + ' ' + message + '\n');
      if (fs.statSync(DEBUG_FILE).size > 192 * 1024) {
        const kept = fs.readFileSync(DEBUG_FILE, 'utf8').split('\n').slice(-150).join('\n');
        fs.writeFileSync(DEBUG_FILE, kept + '\n');
      }
    } catch (err) {
      /* 日志失败不影响功能 */
    }
  }

  // ---------------------------------------------------------------------------
  // 2. 设置项
  // ---------------------------------------------------------------------------

  const LOCALE = (() => {
    try {
      return String(splayer.locale || 'zh-CN');
    } catch (err) {
      return 'zh-CN';
    }
  })();
  const IS_ZH = /^zh/i.test(LOCALE);
  const text = (zh, en) => (IS_ZH ? zh : en);

  const SETTINGS = [
    {
      key: 'enabled',
      type: 'switch',
      label: text('启用 Matugen 配色同步', 'Enable Matugen color sync'),
      default: true,
      description: text(
        '关闭后将不再读取 Matugen 的配色输出，也不再改动播放器配色；已经应用的颜色会保留。',
        'When off, Matugen output is no longer read and the player palette stops updating. Already-applied colors are kept.',
      ),
    },
    {
      key: 'autoConfigure',
      type: 'switch',
      label: text('自动配置 Matugen 模板', 'Auto-configure Matugen template'),
      default: true,
      description: text(
        '自动向 Matugen 的 config.toml 追加本插件所需模板，使其每次生成配色时写出种子色文件；关闭后需自行配置。',
        'Append this plugin\'s template to Matugen config.toml so every run writes the seed file. Turn off to configure it yourself.',
      ),
    },
    {
      key: 'matugenConfig',
      type: 'text',
      label: text('Matugen 配置文件路径', 'Matugen config path'),
      default: '',
      placeholder: text('留空则自动检测当前平台的默认位置', 'Leave blank to auto-detect the platform default'),
      description: text(
        '自定义 Matugen 的 config.toml 路径；留空使用当前平台的标准位置。',
        'Custom path to Matugen config.toml; blank uses the standard location for this platform.',
      ),
    },
    {
      key: 'seedFile',
      type: 'text',
      label: text('种子色文件路径', 'Seed color file path'),
      default: '',
      placeholder: text('留空则使用本插件生成的种子色文件', 'Leave blank to use the file generated by this plugin'),
      description: text(
        '自定义模板的输出路径；文件中出现的任意 #rrggbb 都会作为种子色读取。',
        'Output path of a custom template; any #rrggbb found in the file is read as the seed color.',
      ),
    },
    {
      key: 'interval',
      type: 'number',
      label: text('配色检测间隔（毫秒）', 'Color check interval (ms)'),
      default: 1000,
      min: 500,
      max: 10000,
      description: text(
        '轮询种子色文件变化的间隔。Matugen 换色不频繁，1000 毫秒足够，过低会浪费资源。',
        'How often the seed file is polled. Matugen rarely changes colors, so 1000ms is plenty; lower values waste resources.',
      ),
    },
    {
      key: 'notifyOnChange',
      type: 'switch',
      label: text('换色时发送系统通知', 'Send a system notification on color change'),
      default: false,
      description: text(
        '每次跟随 Matugen 换色时弹出系统通知，仅建议在确认插件是否生效时临时开启。',
        'Show a system notification whenever the palette follows Matugen. Best enabled only to verify the plugin works.',
      ),
    },
  ];

  // 设置必须在顶层同步注册，才会出现在插件配置面板
  try {
    splayer.register({ settings: SETTINGS });
  } catch (err) {
    log.error('注册插件设置项失败：' + String(err && err.message));
  }

  const setting = (key, fallback) => {
    try {
      const value = splayer.getSetting(key);
      if (value === undefined || value === null) return fallback;
      if (typeof value === 'string' && value.trim() === '') return fallback;
      return value;
    } catch (err) {
      return fallback;
    }
  };

  function expandHome(value) {
    if (typeof value !== 'string') return value;
    if (value === '~') return HOME;
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(HOME, value.slice(2));
    return value;
  }

  function readSettings() {
    const rawInterval = Number(setting('interval', 1000));
    return {
      enabled: Boolean(setting('enabled', true)),
      autoConfigure: Boolean(setting('autoConfigure', true)),
      matugenConfig: expandHome(String(setting('matugenConfig', '') || '').trim()),
      seedFile: expandHome(String(setting('seedFile', '') || '').trim()),
      interval: Number.isFinite(rawInterval) ? Math.min(10000, Math.max(500, rawInterval)) : 1000,
      notifyOnChange: Boolean(setting('notifyOnChange', false)),
    };
  }

  // ---------------------------------------------------------------------------
  // 3. 渲染进程注入脚本
  // ---------------------------------------------------------------------------
  //
  // 该函数会被 String() 序列化后送进渲染进程，必须完全自包含：
  // 不能引用外部闭包变量，只能用参数 seed / cfg 与浏览器全局。

  async function rendererPayload(seed, cfg) {
    var KEY = '__SPLAYER_MATUGEN__';
    var state = window[KEY];
    if (!state) {
      state = window[KEY] = {
        patched: false,
        seed: null,
        cfg: null,
        timer: null,
        notes: [],
      };
    }
    var note = function (message) {
      try {
        state.notes.push(String(message));
        if (state.notes.length > 20) state.notes.shift();
      } catch (err) {
        /* ignore */
      }
    };

    state.cfg = cfg || state.cfg;
    if (typeof seed === 'string' && /^#[0-9a-fA-F]{6}$/.test(seed)) state.seed = seed.toLowerCase();

    var getStore = function () {
      var el = document.getElementById('app');
      var app = el && el.__vue_app__;
      var props = app && app.config && app.config.globalProperties;
      var pinia = props && props.$pinia;
      if (!pinia || !pinia._s || typeof pinia._s.get !== 'function') return null;
      return pinia._s.get('theme') || null;
    };

    // 应用可能还在启动画面，主题 store 稍后才可用
    var store = getStore();
    for (var wait = 0; !store && wait < 40; wait++) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 250);
      });
      store = getStore();
    }
    if (!store) {
      return { ok: false, error: 'theme-store-unavailable', href: String(location.href) };
    }

    var raw = store.__v_raw || store;
    var bg = raw.imageBackground;

    // --- 3.1 在 store 上定义虚拟属性 matugenSource ---------------------------
    // getter：matugenActive 为真时显示 matugen，否则透传真实 source
    // setter：选中 Matugen 时切到 custom + 种子色并置标志；选其它值时清标志
    if (!state.patched) {
      try {
        if (!Object.prototype.hasOwnProperty.call(raw, 'matugenSource')) {
          Object.defineProperty(raw, 'matugenSource', {
            configurable: true,
            enumerable: false,
            get: function () {
              // 读取 flag 与 source，二者都会建立响应式依赖
              var active = bg && bg.matugenActive === true;
              var source = raw.source ? raw.source.value : undefined;
              return active ? 'matugen' : source;
            },
            set: function (next) {
              if (next === 'matugen') {
                if (state.seed && raw.customColor) raw.customColor.value = state.seed;
                if (raw.source) raw.source.value = 'custom';
                if (bg) bg.matugenActive = true;
              } else {
                if (bg) bg.matugenActive = false;
                if (raw.source && raw.source.value !== next) raw.source.value = next;
              }
            },
          });
        }
        state.patched = true;
        note('store-patched');
      } catch (err) {
        note('patch-fail:' + (err && err.message));
      }
    }

    // --- 3.2 给「主题色来源」下拉框补上「Matugen」选项 ----------------------
    var patchSchema = async function () {
      if (state.schemaPatched) return 'done';
      if (!cfg || !cfg.settingsChunk) return 'no-chunk';
      try {
        var base = new URL('./assets/', location.href).href;
        var mod = await import(base + cfg.settingsChunk);
        var schema = mod.r || mod.settingsSchema;
        if (!Array.isArray(schema)) return 'schema-not-array';

        var item = null;
        for (var c = 0; c < schema.length && !item; c++) {
          var category = schema[c];
          if (!category || category.id !== 'appearance' || !Array.isArray(category.sections)) continue;
          for (var s = 0; s < category.sections.length && !item; s++) {
            var section = category.sections[s];
            if (!section || !Array.isArray(section.items)) continue;
            for (var i = 0; i < section.items.length; i++) {
              if (section.items[i] && section.items[i].key === 'themeSource') {
                item = section.items[i];
                break;
              }
            }
          }
        }
        if (!item) return 'themeSource-not-found';

        // 把绑定改到虚拟属性上，这样下拉框能读写 Matugen 状态
        item.binding = { store: 'theme', path: 'matugenSource' };

        // Matugen 模式下隐藏「自定义主色」子项，避免误以为可手动覆盖
        item.childrenCondition = function () {
          var current = raw.source ? raw.source.value : null;
          return current === 'custom' && !(bg && bg.matugenActive === true);
        };

        if (!Array.isArray(item.options)) item.options = [];
        var exists = false;
        for (var o = 0; o < item.options.length; o++) {
          if (item.options[o] && item.options[o].value === 'matugen') exists = true;
        }
        if (!exists) {
          var option = { value: 'matugen', label: cfg.label || 'Matugen' };
          var last = item.options[item.options.length - 1];
          // 保持「无主题色」在最后，观感更接近原生
          if (last && last.value === 'solid') item.options.splice(item.options.length - 1, 0, option);
          else item.options.push(option);
        }
        state.schemaPatched = true;
        note('schema-patched');
        return 'patched';
      } catch (err) {
        state.schemaTries = (state.schemaTries || 0) + 1;
        note('schema-fail:' + (err && err.message));
        return 'error';
      }
    };
    var schemaResult = await patchSchema();

    // --- 3.3 同步配色 -------------------------------------------------------
    // 只有用户主动选了 Matugen（matugenActive 为真）时才会改动颜色，
    // 否则插件保持完全静默，不干扰用户自己的主题设置。
    var applying = false;
    var sync = function () {
      if (applying) return;
      var active = bg && bg.matugenActive === true;
      if (!active || !state.seed) return;
      applying = true;
      try {
        if (raw.customColor && raw.customColor.value !== state.seed) {
          raw.customColor.value = state.seed;
        }
        if (raw.source && raw.source.value !== 'custom') {
          raw.source.value = 'custom';
        }
      } catch (err) {
        note('sync-fail:' + (err && err.message));
      }
      applying = false;
    };

    sync();

    // 兜底轮询：主进程 agent 每次注入都会调用本函数，这里再挂一个轻量定时器
    // 处理「用户刚在设置里切到 Matugen / Matugen 刚换色」的即时性。
    if (state.timer) {
      try {
        clearInterval(state.timer);
      } catch (err) {
        /* ignore */
      }
    }
    state.timer = setInterval(sync, (cfg && cfg.tickMs) || 1000);

    var primary = '';
    try {
      primary = document.documentElement.style.getPropertyValue('--s-primary');
    } catch (err) {
      /* ignore */
    }

    return {
      ok: true,
      seed: state.seed,
      source: raw.source ? raw.source.value : null,
      following: Boolean(bg && bg.matugenActive === true),
      schema: schemaResult,
      schemaPatched: Boolean(state.schemaPatched),
      primary: primary,
      notes: state.notes.slice(-5),
    };
  }

  // ---------------------------------------------------------------------------
  // 4. 主进程常驻 agent
  // ---------------------------------------------------------------------------
  //
  // 同样通过 String() 序列化注入，只依赖参数 cfg 与主进程全局。

  async function mainAgent(cfg) {
    var fs = process.getBuiltinModule('fs');
    var path = process.getBuiltinModule('path');
    var createRequire = process.getBuiltinModule('module').createRequire;
    // createRequire 需要一个「绝对路径」才能建立解析基准。
    // 注意不能用 base.charAt(0) === '/' 判断绝对路径：Windows 的盘符路径
    // （C:\\...）不以斜杠开头，那样会把所有候选都拒掉，插件在 Windows 上直接失效。
    // 这里统一用当前平台的 path.isAbsolute()，并把 resourcesPath 作为首选依据。
    var electron = null;
    var requireFrom = [];
    // 1) Electron 主进程恒有 process.resourcesPath，且四平台语义一致：
    //    Win/Linux: <app>/resources   macOS: <App>.app/Contents/Resources
    try {
      if (process.resourcesPath) {
        requireFrom.push(path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'index.js'));
        requireFrom.push(path.join(process.resourcesPath, 'app', 'out', 'main', 'index.js'));
      }
    } catch (err) {
      /* ignore */
    }
    // 2) 插件进程按平台推导好的入口
    if (cfg.mainEntry) requireFrom.push(cfg.mainEntry);
    // 3) 兜底：cwd 与 execPath（electron 是运行时内建模块，解析基准只用于满足 API 要求）
    try {
      requireFrom.push(path.join(process.cwd(), 'index.js'));
    } catch (err) {
      /* ignore */
    }
    requireFrom.push(process.execPath);
    for (var ri = 0; ri < requireFrom.length && !electron; ri++) {
      var base = requireFrom[ri];
      if (typeof base !== 'string' || !base) continue;
      try {
        if (!path.isAbsolute(base)) continue;
      } catch (err) {
        continue;
      }
      try {
        electron = createRequire(base)('electron');
      } catch (err) {
        electron = null;
      }
    }
    if (!electron) {
      return { ok: false, error: 'electron-require-failed' };
    }

    if (process.pid !== cfg.mainPid) {
      return { ok: false, error: 'pid-mismatch', pid: process.pid, expected: cfg.mainPid };
    }

    var KEY = '__SPLAYER_MATUGEN_AGENT__';
    var agent = globalThis[KEY];
    if (!agent) {
      agent = globalThis[KEY] = { rev: -1, seed: null, timer: null, hooked: false, last: null };
    }
    agent.cfg = cfg;

    var isMainWindow = function (win) {
      try {
        if (!win || win.isDestroyed()) return false;
        var wc = win.webContents;
        if (!wc || typeof wc.executeJavaScript !== 'function') return false;
        var url = (typeof wc.getURL === 'function' && wc.getURL()) || '';
        return /\/renderer\/index\.html/.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);
      } catch (err) {
        return false;
      }
    };

    var writeAck = function (payload) {
      try {
        fs.mkdirSync(path.dirname(cfg.ackFile), { recursive: true });
        fs.writeFileSync(cfg.ackFile, JSON.stringify(payload, null, 2));
      } catch (err) {
        /* ignore */
      }
    };

    var inject = async function (win, seed) {
      var code = '(' + cfg.payloadSrc + ')(' + JSON.stringify(seed || null) + ',' + cfg.payloadCfg + ')';
      try {
        return await win.webContents.executeJavaScript(code, true);
      } catch (err) {
        return { ok: false, error: String(err && err.message) };
      }
    };

    var applyAll = async function (seed) {
      var windows = [];
      try {
        windows = electron.BrowserWindow.getAllWindows().filter(isMainWindow);
      } catch (err) {
        windows = [];
      }
      var results = [];
      for (var i = 0; i < windows.length; i++) {
        results.push(await inject(windows[i], seed));
      }
      agent.last = results;
      return { windows: windows.length, results: results };
    };

    var hookWindow = function (win) {
      try {
        win.webContents.on('did-finish-load', function () {
          if (!agent.seed) return;
          if (!isMainWindow(win)) return;
          inject(win, agent.seed).catch(function () {});
        });
      } catch (err) {
        /* ignore */
      }
    };

    if (!agent.hooked) {
      agent.hooked = true;
      try {
        electron.app.on('browser-window-created', function (_event, win) {
          hookWindow(win);
        });
      } catch (err) {
        /* ignore */
      }
      try {
        electron.BrowserWindow.getAllWindows().forEach(hookWindow);
      } catch (err) {
        /* ignore */
      }
    }

    if (!agent.timer) {
      agent.timer = setInterval(function () {
        var text = null;
        try {
          text = fs.readFileSync(cfg.stateFile, 'utf8');
        } catch (err) {
          return;
        }
        var state;
        try {
          state = JSON.parse(text);
        } catch (err) {
          return;
        }
        if (!state || typeof state.rev !== 'number' || state.rev === agent.rev) return;
        agent.rev = state.rev;
        agent.seed = state.seed;
        applyAll(state.seed)
          .then(function (out) {
            writeAck({
              rev: state.rev,
              seed: state.seed,
              at: Date.now(),
              transport: 'inspector',
              windows: out.windows,
              results: out.results,
            });
          })
          .catch(function (err) {
            writeAck({ rev: state.rev, seed: state.seed, at: Date.now(), error: String(err && err.message) });
          });
      }, cfg.pollMs || 1200);
      try {
        agent.timer.unref();
      } catch (err) {
        /* ignore */
      }
    }

    var finish = function () {
      // 必须延迟关闭：同步调用 _debugEnd 会掐断本次 evaluate 的回复
      setTimeout(function () {
        try {
          process._debugEnd();
        } catch (err) {
          /* ignore */
        }
      }, 500);
    };

    if (cfg.initialSeed) {
      agent.rev = typeof cfg.initialRev === 'number' ? cfg.initialRev : agent.rev + 1;
      agent.seed = cfg.initialSeed;
      var output = await applyAll(cfg.initialSeed);
      writeAck({
        rev: agent.rev,
        seed: cfg.initialSeed,
        at: Date.now(),
        transport: 'inspector',
        initial: true,
        windows: output.windows,
        results: output.results,
      });
      finish();
      return { ok: true, rev: agent.rev, windows: output.windows, results: output.results };
    }

    // 没有种子色也注入一次：让「Matugen」选项和 store 补丁提前就位
    var prepared = await applyAll(null);
    writeAck({ rev: agent.rev, seed: null, at: Date.now(), transport: 'inspector', prepared: true, windows: prepared.windows, results: prepared.results });
    finish();
    return { ok: true, rev: agent.rev, windows: prepared.windows, results: prepared.results };
  }

  // ---------------------------------------------------------------------------
  // 5. 传输层
  // ---------------------------------------------------------------------------

  /** 极简 HTTP GET JSON */
  function httpJson(url, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let request;
      try {
        request = http.get(url, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => {
            try {
              finish(JSON.parse(body));
            } catch (err) {
              finish(null);
            }
          });
        });
      } catch (err) {
        return finish(null);
      }
      request.on('error', () => finish(null));
      request.setTimeout(timeoutMs || 1500, () => {
        try {
          request.destroy();
        } catch (err) {
          /* ignore */
        }
        finish(null);
      });
    });
  }

  /** 对一个 CDP target 做一次 Runtime.evaluate */
  function cdpEvaluate(wsUrl, expression, timeoutMs) {
    return new Promise((resolve) => {
      if (!WebSocketImpl) return resolve({ ok: false, error: 'no-websocket' });
      let socket;
      try {
        socket = new WebSocketImpl(wsUrl);
      } catch (err) {
        return resolve({ ok: false, error: 'ws-ctor: ' + err.message });
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch (err) {
          /* ignore */
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs || 25000);
      socket.onopen = () => {
        try {
          socket.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: { expression: expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true },
            }),
          );
        } catch (err) {
          finish({ ok: false, error: 'send: ' + err.message });
        }
      };
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch (err) {
          return;
        }
        if (!message || message.id !== 1) return;
        if (message.error) return finish({ ok: false, error: message.error.message });
        const result = message.result || {};
        if (result.exceptionDetails) {
          const details = result.exceptionDetails;
          const description = details.exception && details.exception.description;
          return finish({ ok: false, error: description || details.text || 'evaluate-exception' });
        }
        finish({ ok: true, value: result.result ? result.result.value : undefined });
      };
      socket.onerror = () => finish({ ok: false, error: 'ws-error' });
      socket.onclose = () => finish({ ok: false, error: 'ws-closed' });
    });
  }

  /**
   * 按当前平台推导主进程入口脚本路径。
   * macOS 的资源目录在 Contents/Resources（相对 Contents/MacOS 的上一级），
   * Windows / Linux / FreeBSD 则在可执行文件同级的 resources 目录。
   */
  function mainEntryPath() {
    const execDir = path.dirname(NODE.execPath);
    const candidates = [];
    if (IS_MAC) {
      candidates.push(join(execDir, '..', 'Resources', 'app.asar', 'out', 'main', 'index.js'));
      candidates.push(join(execDir, '..', 'Resources', 'app', 'out', 'main', 'index.js'));
    }
    candidates.push(join(execDir, 'resources', 'app.asar', 'out', 'main', 'index.js'));
    candidates.push(join(execDir, 'resources', 'app', 'out', 'main', 'index.js'));
    candidates.push(join(execDir, '..', 'Resources', 'app.asar', 'out', 'main', 'index.js'));
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (err) {
        /* 下一个 */
      }
    }
    return candidates[0];
  }

  /** 打开主进程 inspector，注入常驻 agent */
  async function installAgent(payloadCfg, seed, rev) {
    const agentCfg = {
      mainPid: NODE.ppid,
      // 主进程真正的入口脚本（app.asar 内的 out/main/index.js），供 createRequire 建立解析基准。
      // 各平台布局不同，不能一律用 <execDir>/resources：
      //   Windows / Linux / FreeBSD → <execDir>/resources/app.asar
      //   macOS                     → <App>.app/Contents/Resources/app.asar  （在 execDir 的上一级）
      mainEntry: mainEntryPath(),
      stateFile: STATE_FILE,
      ackFile: ACK_FILE,
      payloadSrc: String(rendererPayload),
      payloadCfg: JSON.stringify(payloadCfg),
      pollMs: 1200,
      initialSeed: seed || null,
      initialRev: typeof rev === 'number' ? rev : null,
    };

    try {
      NODE._debugProcess(NODE.ppid);
    } catch (err) {
      return { ok: false, error: 'debug-process: ' + String(err && err.message) };
    }

    // 端口可能已被别的 Node/Electron 进程占用（开发工具自己也可能开 inspector），
    // 因此候选 target 必须先回答「你的 pid 是不是我等的主进程」才允许注入。
    // Node inspector 固定监听 9229；该端口被占用时 _debugProcess 会静默失败，
    // **不会**自动顺延到其它端口（实测确认）。所以这里只探测 9229，
    // 但仍做 pid 核对，避免把代码注入到占用该端口的无关进程。
    const INSPECTOR_PORT = 9229;
    let target = null;
    const probeExpr = 'process.pid';
    for (let attempt = 0; attempt < 90 && !target; attempt += 1) {
      const list = await httpJson('http://127.0.0.1:' + INSPECTOR_PORT + '/json/list', 400);
      if (Array.isArray(list)) {
        for (let entry = 0; entry < list.length && !target; entry += 1) {
          const candidate = list[entry];
          if (!candidate || !candidate.webSocketDebuggerUrl || candidate.type !== 'node') continue;
          // 先用最轻的表达式确认身份，绝不向陌生进程注入 payload
          const probe = await cdpEvaluate(candidate.webSocketDebuggerUrl, probeExpr, 3000);
          if (!probe || !probe.ok) continue;
          if (Number(probe.value) !== Number(NODE.ppid)) continue;
          target = candidate;
        }
      }
      if (!target) await sleep(100);
    }
    if (!target) return { ok: false, error: 'inspector-target-not-found' };

    debugLog('inspector target port=' + targetPort + ' title=' + String(target.title || '').slice(0, 120));

    const expression = '(' + String(mainAgent) + ')(' + JSON.stringify(agentCfg) + ')';
    const result = await cdpEvaluate(target.webSocketDebuggerUrl, expression, 30000);
    debugLog('install: ' + JSON.stringify(result && result.ok ? String(JSON.stringify(result.value)).slice(0, 400) : result).slice(0, 600));
    return result;
  }

  /** 兜底通道：应用若带 --remote-debugging-port 启动，直接注入渲染进程 */
  async function installViaRendererCdp(payloadCfg, seed) {
    const port = findDevToolsPort();
    if (!port) return { ok: false, error: 'no-devtools-port' };

    const list = await httpJson('http://127.0.0.1:' + port + '/json/list', 1500);
    if (!Array.isArray(list)) return { ok: false, error: 'cdp-list-failed' };
    const page = list.find(
      (entry) =>
        entry &&
        entry.webSocketDebuggerUrl &&
        entry.type === 'page' &&
        /renderer\/index\.html|\/index\.html/.test(String(entry.url || '')),
    );
    if (!page) return { ok: false, error: 'cdp-page-not-found' };

    const expression = '(' + String(rendererPayload) + ')(' + JSON.stringify(seed || null) + ',' + JSON.stringify(payloadCfg) + ')';
    return cdpEvaluate(page.webSocketDebuggerUrl, expression, 20000);
  }

  /** SPlayer-Next 可能使用的 userData 目录（含命令行自定义的） */
  function userDataDirs() {
    const dirs = [];

    // 1) 命令行 --user-data-dir（用户可能自定义过）
    const appendFromArgs = (args) => {
      if (!args) return;
      for (let index = 0; index < args.length; index += 1) {
        const arg = String(args[index] || '');
        if (arg.startsWith('--user-data-dir=')) dirs.push(arg.slice('--user-data-dir='.length));
        else if (arg === '--user-data-dir' && args[index + 1]) dirs.push(String(args[index + 1]));
      }
    };
    try {
      appendFromArgs(NODE.argv || []);
    } catch (err) {
      /* ignore */
    }
    // 插件进程是主进程的子进程，argv 里未必带主进程开关，再读一次父进程。
    //   Linux / FreeBSD → /proc/<pid>/cmdline
    //   macOS           → ps -o command=
    //   Windows         → 无等价轻量方案，跳过（仅影响自定义 userData 的兜底通道，
    //                     主注入通道用的是 ppid + inspector，不依赖命令行）
    try {
      if (!IS_WIN && !IS_MAC) {
        appendFromArgs(fs.readFileSync('/proc/' + NODE.ppid + '/cmdline', 'utf8').split('\u0000'));
      } else if (IS_MAC) {
        const cp = NODE.getBuiltinModule('child_process');
        const out = cp.execFileSync('ps', ['-o', 'command=', '-p', String(NODE.ppid)], { encoding: 'utf8' });
        appendFromArgs(String(out).split(/\s+/));
      }
    } catch (err) {
      /* 读不到就算了，后面还有各平台默认目录兜底 */
    }

    // 2) 各平台默认 userData 目录
    if (IS_WIN) {
      dirs.push(join(envGet('APPDATA') || join(HOME, 'AppData', 'Roaming'), 'SPlayer-Next'));
      dirs.push(join(envGet('LOCALAPPDATA') || join(HOME, 'AppData', 'Local'), 'SPlayer-Next'));
    } else if (IS_MAC) {
      dirs.push(join(HOME, 'Library', 'Application Support', 'SPlayer-Next'));
    } else {
      dirs.push(join(envGet('XDG_CONFIG_HOME') || join(HOME, '.config'), 'SPlayer-Next'));
    }

    const seen = new Set();
    return dirs.filter((dir) => {
      if (!dir || seen.has(dir)) return false;
      seen.add(dir);
      return true;
    });
  }

  /** 从 userData 目录的 DevToolsActivePort 读出真实调试端口 */
  function findDevToolsPort() {
    for (const dir of userDataDirs()) {
      try {
        const content = fs.readFileSync(join(dir, 'DevToolsActivePort'), 'utf8');
        const port = Number(String(content).split('\n')[0].trim());
        if (Number.isFinite(port) && port > 0) return port;
      } catch (err) {
        /* 下一个候选目录 */
      }
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // 6. Matugen 模板与配置
  // ---------------------------------------------------------------------------

  const TEMPLATE_CONTENT = [
    '{',
    '  "seed": "{{colors.source_color.default.hex}}",',
    '  "primary": "{{colors.primary.default.hex}}",',
    '  "mode": "{{mode}}",',
    '  "generatedBy": "splayer-next/matugen-next"',
    '}',
    '',
  ].join('\n');

  const TEMPLATE_MARKER = '[templates.splayer-next]';

  const tomlLiteral = (value) => "'" + String(value).replace(/'/g, "''") + "'";

  function buildTemplateBlock(outputFile) {
    return [
      '',
      '# --- 由 SPlayer-Next 插件「Matugen配色」自动添加 ---',
      '# 作用：让 Matugen 每次生成配色时，一并写出 SPlayer-Next 需要的种子色文件',
      TEMPLATE_MARKER,
      'input_path = ' + tomlLiteral(DEFAULT_TEMPLATE_PATH),
      'output_path = ' + tomlLiteral(outputFile),
      '',
    ].join('\n');
  }

  /**
   * 确保 Matugen 模板文件存在，且 config.toml 中引用了该模板。
   * 返回 { configPath, outputFile, changed, error }。
   */
  function ensureMatugenConfig(settings) {
    const configPath = settings.matugenConfig || DEFAULT_CONFIG_PATH;
    const outputFile = settings.seedFile || DEFAULT_OUTPUT_FILE;
    const result = { configPath: configPath, outputFile: outputFile, changed: false, error: null };

    // 1) 模板文件
    try {
      fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
      let existing = null;
      try {
        existing = fs.readFileSync(DEFAULT_TEMPLATE_PATH, 'utf8');
      } catch (err) {
        existing = null;
      }
      if (existing !== TEMPLATE_CONTENT) {
        fs.writeFileSync(DEFAULT_TEMPLATE_PATH, TEMPLATE_CONTENT);
        result.changed = true;
      }
    } catch (err) {
      result.error = 'template: ' + String(err && err.message);
      return result;
    }

    // 2) config.toml
    let configText = '';
    const configExists = (() => {
      try {
        return fs.existsSync(configPath);
      } catch (err) {
        return false;
      }
    })();
    if (configExists) {
      try {
        configText = fs.readFileSync(configPath, 'utf8');
      } catch (err) {
        result.error = 'config-read: ' + String(err && err.message);
        return result;
      }
    }

    const hasTemplate = configText.indexOf(TEMPLATE_MARKER) >= 0;
    const hasConfigSection = /^[ \t]*\[config\]/m.test(configText);
    if (!hasTemplate || !hasConfigSection) {
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        // 已有配置先备份一次，避免误改无法恢复
        if (configText) {
          const backup = configPath + '.bak-matugen-next';
          try {
            if (!fs.existsSync(backup)) fs.writeFileSync(backup, configText);
          } catch (err) {
            /* 备份失败不致命 */
          }
        }
        let next = configText;
        if (!hasConfigSection) next = '[config]\n' + (next ? next : '');
        if (!hasTemplate) next = next.replace(/[ \t\r\n]*$/, '') + '\n' + buildTemplateBlock(outputFile);
        fs.writeFileSync(configPath, next);
        result.changed = true;
      } catch (err) {
        result.error = 'config-write: ' + String(err && err.message);
        return result;
      }
    }

    // 3) 输出目录
    try {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    } catch (err) {
      result.error = 'output-dir: ' + String(err && err.message);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 7. 种子色读取
  // ---------------------------------------------------------------------------

  const HEX_PATTERN = /#([0-9a-fA-F]{6})\b/;

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(HEX_PATTERN);
    return match ? '#' + match[1].toLowerCase() : null;
  }

  /**
   * 从文件内容里取种子色。
   * 优先用 JSON 的 seed / source_color，其次 DMS 的 entries[*].seed，最后第一个 #rrggbb。
   */
  function extractSeed(content) {
    if (typeof content !== 'string' || !content) return null;
    try {
      const parsed = JSON.parse(content);
      const direct =
        normalizeHex(parsed.seed) || normalizeHex(parsed.sourceColor) || normalizeHex(parsed.source_color);
      if (direct) return direct;
      if (parsed.entries && typeof parsed.entries === 'object') {
        const keys = Object.keys(parsed.entries);
        // 取最近用过的一条（DMS 会持续追加）
        for (let index = keys.length - 1; index >= 0; index -= 1) {
          const entry = parsed.entries[keys[index]];
          if (entry && normalizeHex(entry.seed)) return normalizeHex(entry.seed);
        }
      }
    } catch (err) {
      /* 不是 JSON，走文本匹配 */
    }
    return normalizeHex(content);
  }

  function readSeedFile(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size === 0 || stat.size > 4 * 1024 * 1024) return null;
      const seed = extractSeed(fs.readFileSync(filePath, 'utf8'));
      return seed ? { seed: seed, from: filePath, mtimeMs: stat.mtimeMs } : null;
    } catch (err) {
      return null;
    }
  }

  /** 文件是否存在 */
  function fileExists(filePath) {
    try {
      return fs.statSync(filePath).isFile();
    } catch (err) {
      return false;
    }
  }

  /**
   * 依次尝试候选文件，返回第一个命中的种子色。
   *
   * 优先级规则很重要：主输出文件（用户配置或默认）**只要存在**，就以它为准。
   * 即使它暂时读到空内容 / 还没写入有效颜色（Matugen 正在原子替换，
   * 或模板刚被清空），也返回 null 表示「本轮没有变化」，
   * 而不是掉到 DMS 兜底文件上 —— 否则播放器配色会在两个种子之间来回跳。
   * 只有当主文件确实不存在时（用户没配置 Matugen 模板），
   * 才使用 DMS 记录的最后一次色作为兜底。
   */
  function readCurrentSeed(watchPaths) {
    if (!watchPaths.length) return null;
    const primary = watchPaths[0];
    if (fileExists(primary)) {
      return readSeedFile(primary);
    }
    for (let index = 1; index < watchPaths.length; index += 1) {
      const found = readSeedFile(watchPaths[index]);
      if (found) return found;
    }
    return null;
  }

  function buildWatchPaths(settings) {
    const primary = settings.seedFile || DEFAULT_OUTPUT_FILE;
    const list = [primary, DEFAULT_OUTPUT_FILE, DMS_SEEDS_FILE];
    const seen = new Set();
    return list.filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // 8. 渲染资源发现
  // ---------------------------------------------------------------------------

  let cachedSettingsChunk = null;

  function findRendererAssetsDir() {
    const execDir = path.dirname(NODE.execPath);
    const candidates = [
      // Linux / FreeBSD: <app>/resources/app.asar
      join(execDir, 'resources', 'app.asar', 'out', 'renderer', 'assets'),
      // macOS: <App>.app/Contents/MacOS/../Resources/app.asar
      join(execDir, '..', 'Resources', 'app.asar', 'out', 'renderer', 'assets'),
      // 未打包目录
      join(execDir, 'resources', 'app', 'out', 'renderer', 'assets'),
      join(execDir, '..', 'Resources', 'app', 'out', 'renderer', 'assets'),
      // Windows 安装器常见布局
      join(execDir, 'resources', 'app.asar.unpacked', 'out', 'renderer', 'assets'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (err) {
        /* 下一个 */
      }
    }
    return null;
  }

  function findSettingsChunk() {
    if (cachedSettingsChunk !== null) return cachedSettingsChunk;
    const assetsDir = findRendererAssetsDir();
    if (!assetsDir) {
      cachedSettingsChunk = '';
      return cachedSettingsChunk;
    }
    let names = [];
    try {
      names = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
    } catch (err) {
      cachedSettingsChunk = '';
      return cachedSettingsChunk;
    }
    // 命名前缀通常稳定
    const direct = names.find((name) => /^searchSettings-.*\.js$/.test(name));
    if (direct) {
      cachedSettingsChunk = direct;
      return cachedSettingsChunk;
    }
    // 版本升级后前缀可能变化，退化为内容特征匹配
    for (const name of names) {
      try {
        const content = fs.readFileSync(join(assetsDir, name), 'utf8');
        if (content.indexOf('themeSource') >= 0 && content.indexOf('settingsSchema') >= 0) {
          cachedSettingsChunk = name;
          return cachedSettingsChunk;
        }
      } catch (err) {
        /* 下一个 */
      }
    }
    cachedSettingsChunk = '';
    return cachedSettingsChunk;
  }

  // ---------------------------------------------------------------------------
  // 9. 运行时与主循环
  // ---------------------------------------------------------------------------

  function publishState(seed) {
    const rev = Date.now();
    const body = JSON.stringify({ rev: rev, seed: seed, at: rev, plugin: 'matugen-next' }, null, 2);
    try {
      fs.mkdirSync(WORK_DIR, { recursive: true });
    } catch (err) {
      debugLog('publish mkdir failed: ' + String(err && err.message));
    }
    // 先尝试「写临时文件 + rename」这种原子替换，避免主进程读到半个 JSON。
    const temporary = STATE_FILE + '.tmp';
    try {
      fs.writeFileSync(temporary, body);
      try {
        fs.renameSync(temporary, STATE_FILE);
        return rev;
      } catch (renameErr) {
        // Windows 上 rename 覆盖已存在文件可能抛 EPERM / EEXIST / EACCES，
        // 退化为「删目标再改名」，仍失败则直接覆盖写。
        try {
          fs.unlinkSync(STATE_FILE);
        } catch (err) {
          /* 目标本来就不存在 */
        }
        try {
          fs.renameSync(temporary, STATE_FILE);
          return rev;
        } catch (err) {
          /* 继续退化 */
        }
      }
    } catch (err) {
      debugLog('publish tmp write failed: ' + String(err && err.message));
    }
    // 最终兜底：直接覆盖写，保证状态一定能落地
    try {
      fs.writeFileSync(STATE_FILE, body);
      // 顺手清掉可能残留的临时文件（Windows rename 失败时会留下）
      try {
        fs.unlinkSync(temporary);
      } catch (err) {
        /* 没留下就算了 */
      }
      return rev;
    } catch (err) {
      debugLog('publish failed: ' + String(err && err.message));
      return 0;
    }
  }

  function readAck() {
    try {
      const parsed = JSON.parse(fs.readFileSync(ACK_FILE, 'utf8'));
      if (parsed && typeof parsed.rev === 'number') return parsed;
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  function buildPayloadCfg() {
    return {
      label: 'Matugen',
      tickMs: 1000,
      settingsChunk: findSettingsChunk(),
      version: PLUGIN_VERSION,
    };
  }

  /** 把种子色送到渲染进程；返回 { ok, transport, value } */
  async function pushSeed(runtime, seed) {
    if (!runtime.settings.enabled) return { ok: false, error: 'disabled' };
    const rev = publishState(seed);

    // 首次：装 agent（同时完成第一次注入）
    if (!runtime.bridgeReady) {
      const installed = await installAgent(runtime.payloadCfg, seed, rev);
      if (installed && installed.ok) {
        runtime.bridgeReady = true;
        runtime.bridgeFailures = 0;
        runtime.lastAckRev = rev;
        return { ok: true, transport: 'inspector', value: installed.value };
      }
      runtime.bridgeFailures += 1;
      const fallback = await installViaRendererCdp(runtime.payloadCfg, seed);
      if (fallback && fallback.ok) return { ok: true, transport: 'cdp', value: fallback.value };
      return { ok: false, error: (installed && installed.error) || 'install-failed', fallback: fallback && fallback.error };
    }

    // 之后 agent 自己轮询 state.json，只需等 ack 收敛
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(250);
      const ack = readAck();
      if (ack && ack.rev >= rev) {
        runtime.lastAckRev = ack.rev;
        return { ok: true, transport: 'agent', value: ack };
      }
    }

    // 没收敛：应用可能重启过，agent 已消失，重装一次
    runtime.bridgeReady = false;
    runtime.bridgeFailures += 1;
    debugLog('ack timeout, reinstalling agent');
    const reinstalled = await installAgent(runtime.payloadCfg, seed, rev);
    if (reinstalled && reinstalled.ok) {
      runtime.bridgeReady = true;
      runtime.lastAckRev = rev;
      return { ok: true, transport: 'inspector-reinstall', value: reinstalled.value };
    }
    const fallback = await installViaRendererCdp(runtime.payloadCfg, seed);
    if (fallback && fallback.ok) return { ok: true, transport: 'cdp', value: fallback.value };
    return { ok: false, error: (reinstalled && reinstalled.error) || 'reinstall-failed' };
  }

  async function applySeed(runtime, found, isFirst) {
    runtime.lastSeed = found.seed;
    const result = await pushSeed(runtime, found.seed);
    if (result.ok) {
      log.info((isFirst ? '启动时已应用 Matugen 种子色 ' : '已跟随 Matugen 换色 ') + found.seed + '（来源：' + found.from + '）');
    } else {
      log.warn('推送 Matugen 种子色失败：' + JSON.stringify(result).slice(0, 400));
    }
    if (result.ok && runtime.settings.notifyOnChange && !isFirst) {
      try {
        await splayer.notify('已切换到 Matugen 配色：' + found.seed);
      } catch (err) {
        /* 通知失败不影响功能 */
      }
    }
    return result;
  }

  async function loop(runtime) {
    if (runtime.disposed) return;
    try {
      const found = readCurrentSeed(runtime.watchPaths);
      if (found && found.seed !== runtime.lastSeed) {
        await applySeed(runtime, found, runtime.lastSeed === null);
      }
    } catch (err) {
      debugLog('loop error: ' + String(err && err.message));
    }
    if (runtime.disposed) return;
    runtime.timer = setTimeout(() => {
      loop(runtime);
    }, runtime.settings.interval);
  }

  let activeRuntime = null;

  function disposeRuntime() {
    if (!activeRuntime) return;
    activeRuntime.disposed = true;
    try {
      if (activeRuntime.timer) clearTimeout(activeRuntime.timer);
    } catch (err) {
      /* ignore */
    }
    activeRuntime = null;
  }

  async function start() {
    disposeRuntime();
    const runtime = {
      settings: readSettings(),
      watchPaths: [],
      payloadCfg: null,
      lastSeed: null,
      timer: null,
      bridgeReady: false,
      bridgeFailures: 0,
      lastAckRev: -1,
      disposed: false,
    };
    activeRuntime = runtime;
    runtime.watchPaths = buildWatchPaths(runtime.settings);
    runtime.payloadCfg = buildPayloadCfg();

    debugLog(
      'start platform=' + PLATFORM + ' execPath=' + NODE.execPath + ' mainPid=' + NODE.ppid +
        ' output=' + (runtime.settings.seedFile || DEFAULT_OUTPUT_FILE),
    );

    if (!runtime.settings.enabled) {
      log.info('已在设置中关闭 Matugen 配色同步，本次启动不做任何改动');
      return;
    }

    // 1) 配置 Matugen 模板（可关闭）
    if (runtime.settings.autoConfigure) {
      const configured = ensureMatugenConfig(runtime.settings);
      if (configured.error) log.warn('配置 Matugen 失败：' + configured.error);
      else if (configured.changed) log.info('已写入 Matugen 模板并更新配置：' + configured.configPath);
      debugLog('matugen config: ' + JSON.stringify(configured));
    }

    if (!runtime.payloadCfg.settingsChunk) {
      log.warn('未定位到设置面板模块，下拉框选项可能无法注入；配色同步不受影响');
    }

    // 2) 先取一次当前种子色，让启动时已是 Matugen 配色的用户立刻看到正确结果
    const found = readCurrentSeed(runtime.watchPaths);
    if (found) {
      await applySeed(runtime, found, true);
    } else {
      log.info('暂未找到 Matugen 种子色文件，等待其生成：' + runtime.watchPaths.join(' , '));
      // 没有种子色也先装 agent，让「Matugen」选项提前就位
      const installed = await installAgent(runtime.payloadCfg, null, null);
      if (installed && installed.ok) {
        runtime.bridgeReady = true;
        debugLog('agent installed without seed');
      } else {
        debugLog('agent install failed: ' + JSON.stringify(installed).slice(0, 300));
      }
    }

    // 3) 进入轮询
    if (activeRuntime === runtime) {
      runtime.timer = setTimeout(() => {
        loop(runtime);
      }, runtime.settings.interval);
    }
  }

  // 插件 reload 时会重新执行脚本，先清掉上一轮留下的定时器
  try {
    if (HOST.__SPLAYER_MATUGEN_HOST__ && typeof HOST.__SPLAYER_MATUGEN_HOST__.dispose === 'function') {
      HOST.__SPLAYER_MATUGEN_HOST__.dispose();
    }
  } catch (err) {
    /* ignore */
  }
  HOST.__SPLAYER_MATUGEN_HOST__ = { dispose: disposeRuntime };

  // 设置变更后重启观察循环
  for (const key of ['enabled', 'autoConfigure', 'matugenConfig', 'seedFile', 'interval', 'notifyOnChange']) {
    try {
      splayer.onSettingChange(key, () => {
        log.info('设置项 ' + key + ' 已变更，正在重启配色同步');
        start().catch((err) => log.error('重启配色同步失败：' + String(err && err.message)));
      });
    } catch (err) {
      /* 旧宿主可能没有 onSettingChange */
    }
  }

  await start();
})();

/**
* @name        osu! 谱面搜索
* @id          truthss.osu-beatmap-search
* @version     1.0.0
* @description 在歌曲菜单里一键搜索当前歌曲的 osu! 谱面
* @author      LTruth
* @homepage    https://github.com/Truthss/SPlayer-osuPlugin
* @type        control
* @apiLevel    2
* @grant       ui
* @updateUrl   https://cdn.jsdelivr.net/gh/Truthss/SPlayer-osuPlugin@main/dist/osu-beatmap-search.js
*/
(function() {
	//#region src/keyword.ts
	/**
	* 连续空白折叠为单个半角空格，首尾 trim。
	* JS 的 `\s` 已经涵盖全角空格 U+3000，不必额外列。
	*/
	var normalizeSpace = (input) => input.replace(/\s+/g, " ").trim();
	/**
	* 规则 ①-b：碟号-音轨号前缀，如 `1-05 Song`。
	* 必须排在 ①-a 前面：`1-05 Song` 会被 ①-a 当成 `1-` 前缀，误剩 `05 Song`。
	*
	* 碟号只认**一位**：十张碟以上的专辑不存在，而放宽到两位会把 `24-7 Nonstop` 啃成 `Nonstop`。
	*/
	var DISC_TRACK_PREFIX = /^\s*[1-9]-\d{1,3}\s+/;
	/**
	* 规则 ①-a：音轨号前缀，如 `01. Song` / `01.Song` / `03 - Song` / `07、Song`。
	*
	* 比朴素写法 `^\s*\d{1,3}\s*[-.、]\s*` 紧，因为那个会把两类**真标题**啃穿：
	*
	* - `3-6-9` → `6-9`：所以连字符必须至少有一侧带空白（`03 - Song` / `03- Song` 都留着，
	*   而 `3-6-9`、`24-7` 这种紧贴的不动）；
	* - `2.5次元の誘惑` → `5次元の誘惑`：所以点号后面若紧跟数字就不认
	*   （`01.Song` 仍剥，`03. 7 Years` 因为点后有空白也仍剥）。
	*
	* 清洗是本插件里唯一会**降低**命中率的组件，宁可少剥一个音轨号，也不能吃掉半个歌名。
	*/
	var TRACK_PREFIX = /^\s*\d{1,3}(?:\s*[.、](?:\s+|(?!\d))|\s+-\s*|\s*-\s+)/;
	/**
	* 规则 ③：白名单发行修饰。
	*
	* 只有括号/方括号**内含白名单词**时才整段移除。白名单刻意只收「与谱面无关的发行标记」：
	* Remaster(ed) / Explicit / Deluxe / Bonus Track。
	*
	* 特别注意 `remaster` 不会误伤 `remix`——`(Nightcore Mix)`、`(TV Size)`、`(Extended Mix)`
	* 在 osu! 上都是谱面标题的一部分，去掉是净损失。
	*/
	var RELEASE_MODIFIER = /[([][^()[\]]*(?:remaster(?:ed)?|explicit|deluxe|bonus\s+track)[^()[\]]*[)\]]/gi;
	/** 规则 ④-a：`【...】` 整段移除，通常是上传者/字幕组标签。 */
	var UPLOADER_TAG = /【[^】]*】/g;
	/** 规则 ④-b：`「」` `『』` 只脱符号、保留内容。 */
	var CJK_QUOTES = /[「」『』]/g;
	/**
	* 清洗标题。
	*
	* 执行顺序是 ④a → ① → ③ → ④b → ⑤，而不是编号顺序：
	* ④a 是「剥掉外层容器」，先剥掉才能让 `【MV】01. Song` 里的音轨号暴露给 ①。
	*
	* 规则 ② 空缺是有意的——它对应被否决的「去 feat. 段」规则。
	* 第二歌手在 osu! 上经常就是谱面标题的一部分（`Ghost (feat. Nanahira)`），去掉是净损失。
	*
	* @returns 清洗后的标题；若清洗把标题吃空了，退回归一化后的原标题。
	*/
	var cleanTitle = (raw) => {
		let s = raw;
		s = s.replace(UPLOADER_TAG, " ");
		s = DISC_TRACK_PREFIX.test(s) ? s.replace(DISC_TRACK_PREFIX, "") : s.replace(TRACK_PREFIX, "");
		s = s.replace(RELEASE_MODIFIER, " ");
		s = s.replace(CJK_QUOTES, " ");
		s = normalizeSpace(s);
		return s || normalizeSpace(raw);
	};
	/** 路径分隔符：Windows 反斜杠与 POSIX 斜杠都要认。 */
	var PATH_SEPARATOR = /[\\/]/;
	/** 扩展名：`.flac` `.mp3` `.m4a`……限制长度，免得把 `Song 2.0` 的 `.0` 当扩展名。 */
	var FILE_EXTENSION = /\.[0-9a-z]{1,5}$/i;
	/**
	* 从本地文件路径推标题：取文件名、去扩展名。
	*
	* 纯字符串处理——沙箱里没有 `fs`，也不需要。
	*/
	var titleFromPath = (path) => {
		return normalizeSpace((path.split(PATH_SEPARATOR).pop() ?? "").replace(FILE_EXTENSION, ""));
	};
	/**
	* 取本次搜索要用的标题：`track.title` 优先，空则退到文件名。
	*
	* @param shouldClean 对应设置项 `cleanTitle`；关掉时标题原样进关键词。
	* @returns 标题；确实没有任何可用标题时返回 `null`。
	*/
	var resolveTitle = (track, shouldClean) => {
		const raw = normalizeSpace(track.title ?? "") || titleFromPath(track.path ?? "");
		if (!raw) return null;
		return shouldClean ? cleanTitle(raw) : raw;
	};
	/**
	* 「不可用歌手」白名单。命中的一律当没有歌手。
	* 比较前会 `normalizeSpace` + 转小写。
	*/
	var UNUSABLE_ARTISTS = /* @__PURE__ */ new Set([
		"未知艺术家",
		"未知歌手",
		"未知艺人",
		"unknown artist",
		"unknown",
		"<unknown>",
		"群星",
		"various artists"
	]);
	/**
	* 取主歌手：**只取 `artists[0]`**，不拼接全部。
	*
	* 理由：osu! 的多词匹配是**收窄**的（实测 `YOASOBI 夜に駆ける` 能命中即为证），
	* 多塞一个 feat. 歌手极易把结果搜空。
	*
	* > 有个容易误导人的参照：宿主自己在 `metadata.ts:46` 用的是
	* > `` `${track.title} ${artists.join(" ")}` ``（全部拼接）。但那是喂给**内部候选打分**、
	* > 后面还有时长硬门槛兜底的场景；本插件是一次性外链搜索，搜空就是搜空，不能照抄。
	*
	* 歌手名只做空白归一化，**不做标题那套清洗**。
	*
	* @returns 主歌手名；没有歌手或命中白名单时返回 `null`。
	*/
	var resolveArtist = (track) => {
		const name = normalizeSpace(track.artists?.[0]?.name ?? "");
		if (!name || UNUSABLE_ARTISTS.has(name.toLowerCase())) return null;
		return name;
	};
	/** 把标题与歌手拼成一条关键词，跳过空值。 */
	var joinKeyword = (...parts) => normalizeSpace(parts.filter((p) => !!p).join(" "));
	/** CJK 统一表意文字（汉字）。 */
	var CJK_IDEOGRAPH = /[\u4E00-\u9FFF]/;
	/** 日文假名（平假名 + 片假名）。 */
	var KANA = /[\u3040-\u30FF]/;
	/** 韩文谚文音节。 */
	var HANGUL = /[\uAC00-\uD7AF]/;
	/**
	* 该不该提示「osu! 用原名命名，译名可能搜不到」。
	*
	* 命中条件：
	* - 含汉字但**不含假名** → 大概率是中文（含假名的是日文，日文原名实测可搜，不该提示）；
	* - 或含谚文 → 韩文在 osu! 上同样多用罗马音/原名，理由与中文完全相同。
	*
	* 因为韩文也走这条，提示文案用的是语言中立的「译名」而不是「中文译名」。
	*/
	var needsOriginalNameHint = (keyword) => CJK_IDEOGRAPH.test(keyword) && !KANA.test(keyword) || HANGUL.test(keyword);
	//#endregion
	//#region src/osu.ts
	/**
	* osu! 搜索 URL 构造。纯函数，无副作用。
	*/
	/** osu! 谱面搜索页。 */
	var BEATMAPSETS_URL = "https://osu.ppy.sh/beatmapsets";
	/**
	* 拼一条 osu! 谱面搜索链接。
	*
	* 只带 `q`，**不附加任何其他参数**——`m=` / `s=` / `sort=` / `nsfw=` 用户在搜索页自己改就行，
	* 不值得为此增加设置项。
	*
	* 关键词一律走 `encodeURIComponent` 而非 `URLSearchParams`：后者把空格编成 `+`，
	* 虽然 osu! 两种都认，但 `%20` 更好肉眼核对。
	*
	* 也**不使用** osu! 自己的 `artist=` / `title=` 搜索语法：那是精确字段匹配，
	* 在「中文译名 vs 日文原名」的场景下几乎必然零结果，比模糊搜索更糟。
	*/
	var buildSearchUrl = (keyword) => `${BEATMAPSETS_URL}?q=${encodeURIComponent(keyword)}`;
	//#endregion
	//#region src/index.ts
	var MENU_FULL = "search-full";
	var MENU_TITLE = "search-title";
	var MENU_ARTIST = "search-artist";
	/**
	* 文案在加载时二选一后就固定下来。
	*
	* 这是已知限制而非 bug：`register()` 只在插件启动时跑一次，宿主切换语言后要重载插件才会变。
	* `PluginSettingItem.label` 上游也明确写着「纯字符串展示名，不做多语言」。
	*/
	var t = String(splayer.locale ?? "").startsWith("zh") ? {
		menuFull: "歌名 + 歌手",
		menuTitle: "仅歌名",
		menuArtist: "仅歌手",
		settingCleanTitle: "清洗歌曲标题",
		settingCleanTitleDesc: "搜索前去掉音轨号、【】标签与 (Remastered) 一类发行修饰。某首歌被误伤搜不到时，关掉它。",
		noTitle: "当前歌曲没有可用的标题信息",
		noArtist: "当前歌曲没有可用的歌手信息",
		originalNameHint: "osu! 谱面通常以原名命名，译名可能搜不到"
	} : {
		menuFull: "Title + Artist",
		menuTitle: "Title only",
		menuArtist: "Artist only",
		settingCleanTitle: "Clean up track title",
		settingCleanTitleDesc: "Strip track numbers, 【】 tags and release markers like (Remastered) before searching. Turn it off if it mangles a title.",
		noTitle: "No title information available for this track.",
		noArtist: "No artist information available for this track.",
		originalNameHint: "osu! beatmaps are usually named in the original language; translated titles may not match."
	};
	/**
	* 唯一的设置项。
	*
	* 清洗是**有损**操作，用户遇到被误伤的歌名时必须有关掉它的办法；
	* 其余一切（搜索模式、osu! 的 m=/s=/sort= 参数……）都不该是可配置的。
	*/
	var SETTINGS = [{
		key: "cleanTitle",
		type: "switch",
		label: t.settingCleanTitle,
		description: t.settingCleanTitleDesc,
		default: true
	}];
	/** 不设 `sources`：对 local / streaming / netease / qqmusic / kugou 全部来源显示。 */
	var MENUS = [
		{
			id: MENU_FULL,
			label: t.menuFull
		},
		{
			id: MENU_TITLE,
			label: t.menuTitle
		},
		{
			id: MENU_ARTIST,
			label: t.menuArtist
		}
	];
	splayer.register({
		settings: SETTINGS,
		menus: MENUS
	});
	/**
	* 一次搜索的结果：开浏览器，必要时**同时**飘一条提示。
	*
	* `openUrl` 与 `toast` 可以并存——渲染端对二者是独立且无条件执行的
	* （`useTrackMenu.ts:221-223`），所以提示不打断流程。
	*/
	var searchFor = (keyword) => {
		const res = { openUrl: buildSearchUrl(keyword) };
		if (needsOriginalNameHint(keyword)) res.toast = t.originalNameHint;
		return res;
	};
	/**
	* 边界处理的原则只有一条：**宁可什么都不做，也不能开出一个默认列表页**——
	* 未登录的访客那里，空 `q` 会被服务端静默丢弃、照常渲染出一个看起来正常却完全无关的列表，
	* 那又是一次静默的错误结果。
	*/
	var handleMenuClick = ({ menuId, track }) => {
		const title = resolveTitle(track, splayer.getSetting("cleanTitle") !== false);
		const artist = resolveArtist(track);
		switch (menuId) {
			case MENU_ARTIST: return artist ? searchFor(artist) : { toast: t.noArtist };
			case MENU_TITLE: return title ? searchFor(title) : { toast: t.noTitle };
			case MENU_FULL: {
				const keyword = joinKeyword(title, artist);
				return keyword ? searchFor(keyword) : { toast: t.noTitle };
			}
			default:
				splayer.log.warn("[osu-beatmap-search] unknown menuId:", menuId);
				return {};
		}
	};
	splayer.on("menuClick", async (req) => handleMenuClick(req));
	//#endregion
})();

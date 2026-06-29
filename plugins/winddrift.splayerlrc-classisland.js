/**
 * @name ClassIsland 联动
 * @id winddrift.splayerlrc-classisland
 * @version 1.0.3
 * @author imsyy & WindDrift
 * @homepage https://github.com/WindDrift/SPlayerLRC-In-ClassIsland
 * @type control
 * @grant network
 * @apiLevel 2
 * @description 把当前歌词推送到 ClassIsland 主界面
 * @updateUrl https://raw.githubusercontent.com/WindDrift/SPlayerLRC-In-ClassIsland/main/SPlayerLRC-In-ClassIsland.js
 */
splayer.register({
  events: ["trackChange", "lyricChange", "lineChange"],
  settings: [
    {
      key: "port",
      type: "number",
      label: "端口",
      description: "ClassIsland 歌词组件监听的本地端口",
      default: 50063,
      min: 1024,
      max: 65535,
    },
    {
      key: "showTranslation",
      type: "switch",
      label: "显示翻译",
      description: "当歌词行包含翻译时，将翻译显示在副行",
      default: true,
    },
    {
      key: "showNextLine",
      type: "switch",
      label: "无翻译时显示下一行",
      description: "当没有翻译可显示时，将下一行歌词显示在副行",
      default: true,
    },
    {
      key: "skipBackgroundLyrics",
      type: "switch",
      label: "跳过背景歌词",
      description: "开启后，背景歌词不会显示在 ClassIsland 上，但其所属主歌词仍会正常显示",
      default: false,
    },
    {
      key: "overlapDuetAsExtra",
      type: "switch",
      label: "重叠对唱显示在副行",
      description: "开启后，与主歌词时间重叠的对唱歌词会显示在副行，主歌词保持显示在主行",
      default: true,
    },
  ],
});

const post = (lyric, extra) => {
  const port = splayer.getSetting("port") || 50063;
  splayer
    .request(`http://127.0.0.1:${port}/component/lyrics/lyrics/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lyric, extra }),
    })
    .catch(() => {});
};

/** 一行歌词 → 纯文本 */
const lineText = (line) => (line && line.words ? line.words.map((w) => w.word).join("") : "");

/** 向前查找最近的主歌词行索引（用于背景歌词） */
const findPrevMainLineIndex = (lines, from) => {
  for (let i = from; i >= 0; i--) {
    if (!lines[i].isBG) return i;
  }
  return -1;
};

/** 查找与当前行时间重叠的最近主歌词行索引（用于对唱） */
const findOverlappingMainLineIndex = (lines, from) => {
  const cur = lines[from];
  for (let i = from - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.isBG || line.isDuet) continue;
    if (line.endTime > cur.startTime) return i;
  }
  return -1;
};

/** 向后查找下一行应显示的歌词行索引（开启跳过时将跳过背景歌词行） */
const findNextLineIndex = (lines, from, skipBG) => {
  for (let i = from + 1; i < lines.length; i++) {
    if (!skipBG || !lines[i].isBG) return i;
  }
  return -1;
};

let lines = [];

splayer.player.on("trackChange", ({ track }) => {
  if (track) post(track.title, track.artists);
});

splayer.player.on("lyricChange", ({ lines: ls }) => {
  lines = ls || [];
});

splayer.player.on("lineChange", ({ index }) => {
  const skipBG = splayer.getSetting("skipBackgroundLyrics");
  const overlapDuet = splayer.getSetting("overlapDuetAsExtra");
  const cur = lines[index];

  let lyric = "";
  let extra = "";
  let mainLine = cur;

  if (cur && cur.isBG) {
    // 当前是背景歌词行，向前找到所属主歌词行
    const mainIdx = findPrevMainLineIndex(lines, index);
    if (mainIdx < 0) {
      // 找不到所属主行时，跳过背景歌词模式下不发送
      if (skipBG) return;
      lyric = lineText(cur);
    } else if (skipBG) {
      // 跳过背景歌词模式下，保持主行显示，但不在副行显示背景歌词
      mainLine = lines[mainIdx];
      lyric = lineText(mainLine);
    } else {
      mainLine = lines[mainIdx];
      lyric = lineText(mainLine);
      extra = lineText(cur);
    }
  } else if (overlapDuet && cur && cur.isDuet) {
    // 当前是对唱行，若与某主行时间重叠，则主行保持主显示，对唱行显示在副行
    const mainIdx = findOverlappingMainLineIndex(lines, index);
    if (mainIdx >= 0) {
      mainLine = lines[mainIdx];
      lyric = lineText(mainLine);
      extra = lineText(cur);
    } else {
      lyric = lineText(cur);
    }
  } else {
    lyric = lineText(cur);
  }

  // 默认情况下，主歌词行的下一行若是背景歌词行，则把背景歌词显示在副行
  if (!skipBG && cur && !cur.isBG && lines[index + 1] && lines[index + 1].isBG) {
    extra = lineText(lines[index + 1]);
  }

  // 仍未确定副行时，按原有逻辑回退：翻译 > 下一行
  if (!extra && mainLine) {
    if (splayer.getSetting("showTranslation") && mainLine.translatedLyric) {
      extra = mainLine.translatedLyric;
    } else if (splayer.getSetting("showNextLine")) {
      const nextIdx = findNextLineIndex(lines, index, skipBG);
      if (nextIdx >= 0) extra = lineText(lines[nextIdx]);
    }
  }

  post(lyric, extra);
});

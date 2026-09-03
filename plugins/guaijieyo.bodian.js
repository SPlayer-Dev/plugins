/// <reference path="plugin-sandbox.d.ts" />
/**
 * @name        波点音乐(看广听歌)
 * @id          guaijieyo.bodian
 * @version     1.0.0
 * @description 从 @UnblockNeteaseMusic/server 移植而来 音质仅Lossless(假无损)和320K(较高)
 * @author      GuaiJie
 * @homepage    https://github.com/guaijieyo
 * @grant network
 * @type        source
 * @apiLevel    2
 */

// 全局化通用 API
const logger = splayer.log;
const { crypto } = splayer.utils;

// =========== 工具函数 ===========

/**
 * 生成随机设备ID（用于API请求）
 * @returns {string} 随机数字字符串
 */
function getRandomDeviceId() {
  const min = 0;
  const max = 100000000000;
  const randomNum = Math.floor(Math.random() * (max - min + 1)) + min;
  return randomNum.toString();
}
const deviceId = getRandomDeviceId();

/**
 * 生成带签名的 URL 地址
 * 签名算法：kuwotest + 排序后的查询参数（仅字母数字） + pathname，再取 MD5
 * @param {string} str - 完整的请求URL
 * @returns {string} 添加了签名参数的URL
 */
function generateSign(str) {
  const url = new URL(str);
  const currentTime = Date.now();
  str += `&timestamp=${currentTime}`;

  const filteredChars = str
    .substring(str.indexOf("?") + 1)
    .replace(/[^a-zA-Z0-9]/g, "")
    .split("")
    .sort();

  const dataToEncrypt = `kuwotest${filteredChars.join("")}${url.pathname}`;
  const md5 = crypto.md5(dataToEncrypt);
  return `${str}&sign=${md5}`;
}

/**
 * 格式化歌曲数据（仅提取必要字段）
 * @param {Object} song - API返回的歌曲原始数据
 * @returns {{ id: string, duration: number }}
 */
function format(song) {
  return {
    id: song.MUSICRID.split("_").pop(),
    duration: song.DURATION * 1000,
  };
}

/**
 * 从搜索结果中选择最佳匹配歌曲
 * @param {Array} list - 格式化后的歌曲列表
 * @param {{duration:number}} info - 包含时长信息
 * @returns {Object|null}
 */
function select(list, info) {
  const { duration } = info;
  const song = list
    .slice(0, 5)
    .find(
      (song) => song.duration && Math.abs(song.duration - duration) < 5 * 1e3,
    );
  return song || list[0] || null;
}

// =========== 公共请求头 ===========
const COMMON_HEADERS = {
  "user-agent": "Dart/2.19 (dart:io)",
  plat: "ar",
  channel: "aliopen",
  devid: deviceId,
  ver: "3.9.0",
};

// 音质映射：外部品质 -> 酷我 br 参数 和 返回格式
const QUALITY_MAP = {
  hq: { br: "320kmp3", format: "mp3", label: "320k" },
  lossless: { br: "2000kflac", format: "flac", label: "lossless" },
};

// =========== 主要函数 ===========

/**
 * 搜索歌曲ID
 * @param {{name:string, singer:string}} musicInfo
 * @param {number|null} [duration=null]
 * @returns {Promise<string|null>}
 */
async function searchMusic(musicInfo, duration = null) {
  try {
    const encodedKeyword = encodeURIComponent(
      musicInfo.name + musicInfo.singer,
    );
    const searchUrl =
      "http://search.kuwo.cn/r.s?&correct=1&vipver=1&stype=comprehensive&encoding=utf8" +
      "&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=" +
      encodedKeyword;

    const jsonBody = await splayer.request(searchUrl, {
      responseType: "json",
    });

    // 更健壮的结构检查
    const abslist = jsonBody?.body?.content?.[1]?.musicpage?.abslist;
    if (!abslist || abslist.length === 0) {
      throw new Error("未搜索到相关歌曲");
    }

    const list = abslist.map(format);

    if (duration && duration > 0) {
      const matched = select(list, { duration });
      return matched ? matched.id : null;
    }

    return list[0] ? list[0].id : null;
  } catch (e) {
    throw new Error(`波点源: 搜索歌曲 ID 时出现错误 - ${e.message}`);
  }
}

/**
 * 发送广告免费请求（解锁VIP权限）
 * @returns {Promise<void>}
 */
async function sendAdFreeRequest() {
  const adurl =
    "http://bd-api.kuwo.cn/api/service/advert/watch?uid=-1&token=&timestamp=1724306124436&sign=15a676d66285117ad714e8c8371691da";

  const data = JSON.stringify({
    type: 5,
    subType: 5,
    musicId: 0,
    adToken: "",
  });

  try {
    await splayer.request(adurl, {
      method: "POST",
      headers: {
        ...COMMON_HEADERS,
        qimei36: "1e9970cbcdc20a031dee9f37100017e1840e",
        "content-type": "application/json; charset=utf-8",
      },
      body: data,
    });
  } catch (e) {
    throw new Error(`波点源: 看广获取权益失败！${e.message}`);
  }
}

/**
 * 获取播放直链
 * @param {string} id - 歌曲ID
 * @param {string} [quality='hq'] - 音质标识（hq/lossless）
 * @returns {Promise<{url:string, format:string, label:string}|null>}
 */
async function track(id, quality = "hq") {
  const qualityInfo = QUALITY_MAP[quality] || QUALITY_MAP.hq;

  try {
    // 构建带签名的请求URL
    let audioUrl = `http://bd-api.kuwo.cn/api/play/music/v2/audioUrl?&br=${qualityInfo.br}&musicId=${id}`;
    audioUrl = generateSign(audioUrl);

    // 先发送广告免费请求
    await sendAdFreeRequest();

    // 获取播放链接
    const resp = await splayer.request(audioUrl, {
      headers: {
        ...COMMON_HEADERS,
        "X-Forwarded-For": "1.0.1.114",
      },
      responseType: "json",
    });

    if (
      !resp.body ||
      resp.status !== 200 ||
      typeof resp.body.data !== "object"
    ) {
      throw new Error("直链获取失败");
    }

    const url = resp.body.data.audioUrl;
    if (!url) {
      throw new Error("直链为空");
    }

    return {
      url,
      format: qualityInfo.format,
      label: qualityInfo.label,
    };
  } catch (e) {
    throw new Error(`波点源: 直链获取失败！${e.message}`);
  }
}

// =========== 插件注册 ===========

splayer.register({
  sources: {
    wy: {
      name: "波点音乐",
      actions: ["musicUrl"],
      qualities: ["hq", "lossless"],
    },
    kg: {
      name: "波点音乐",
      actions: ["musicUrl"],
      qualities: ["hq", "lossless"],
    },
    tx: {
      name: "波点音乐",
      actions: ["musicUrl"],
      qualities: ["hq", "lossless"],
    },
  },
});

splayer.on("musicUrl", async (req) => {
  const { quality } = req;
  const { name, singer } = req.musicInfo;

  const songId = await searchMusic({ name, singer });

  const trackResult = await track(songId, quality);

  if (!trackResult) {
    throw new Error("获取直链失败");
  }

  const res = {
    url: trackResult.url,
    quality: trackResult.label,
  };
  return res;
});

/**
 * @name        ASUS 键盘背光联动
 * @id          winddrift.asus-keyboard-light
 * @version     1.0.0
 * @description 监听当前播放曲目封面变化，通过本地桥接服务将封面主题色应用到华硕键盘背光
 * @author      WindDrift
 * @homepage    https://github.com/WindDrift/SPlayer-ASUS-Keyboard-Light-Controller
 * @type        control
 * @grant       network
 * @apiLevel    2
 * @updateUrl   https://raw.githubusercontent.com/WindDrift/SPlayer-ASUS-Keyboard-Light-Controller/main/SPlayer-ASUS-Keyboard-Light-Controller.js
 */

splayer.register({
  events: ["trackChange"],
  settings: [
    {
      key: "enabled",
      type: "switch",
      label: "启用键盘背光联动",
      default: true,
    },
    {
      key: "bridgeUrl",
      type: "text",
      label: "桥接服务地址",
      default: "http://127.0.0.1:38901",
      placeholder: "http://127.0.0.1:38901",
    },
    {
      key: "mode",
      type: "select",
      label: "灯效类型",
      default: "0",
      options: [
        { label: "恒亮", value: "0" },
        { label: "呼吸", value: "1" },
        { label: "色彩循环", value: "2" },
        { label: "闪烁", value: "10" },
      ],
    },
    {
      key: "brightness",
      type: "select",
      label: "亮度",
      default: "3",
      options: [
        { label: "低", value: "1" },
        { label: "中", value: "2" },
        { label: "高", value: "3" },
      ],
    },
  ],
});

// 缓存当前曲目信息，用于设置变更时重新应用
let currentTrack = null;

/**
 * 将封面主题色通过桥接服务应用到键盘背光
 * @param {object} track - 当前曲目对象，需包含 cover 字段
 */
const applyBacklight = (track) => {
  if (!splayer.getSetting("enabled")) return;
  const url = track && track.cover;
  if (!url || !/^https?:\/\//i.test(url)) {
    splayer.log.debug("仅支持 HTTP 封面，跳过：", url);
    return;
  }
  const bridgeUrl = splayer.getSetting("bridgeUrl");
  const mode = Number(splayer.getSetting("mode"));
  const brightness = Number(splayer.getSetting("brightness"));
  splayer
    .request(`${bridgeUrl}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        mode,
        brightness,
        title: track.title || "",
        artist: track.artist || "",
        album: track.album || "",
      }),
      timeout: 10000,
    })
    .then(({ body }) => {
      if (body && body.ok) {
        splayer.log.info("已应用键盘背光颜色：", body.color);
      } else {
        splayer.log.warn("桥接服务返回失败：", body && body.error);
      }
    })
    .catch((err) => {
      splayer.log.warn("应用键盘背光失败：", err);
    });
};

splayer.player.on("trackChange", ({ track }) => {
  if (!track || !track.cover) {
    currentTrack = null;
    return;
  }
  currentTrack = track;
  applyBacklight(currentTrack);
});

splayer.onSettingChange("mode", () => {
  if (currentTrack) applyBacklight(currentTrack);
});

splayer.onSettingChange("brightness", () => {
  if (currentTrack) applyBacklight(currentTrack);
});

splayer.onSettingChange("enabled", (value) => {
  if (value && currentTrack) applyBacklight(currentTrack);
});

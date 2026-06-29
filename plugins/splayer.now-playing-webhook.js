/**
 * @name        Now Playing 推送
 * @id          splayer.now-playing-webhook
 * @version     1.0.0
 * @author      SPlayer
 * @type        control
 * @grant       network
 * @apiLevel    2
 * @description 切歌时把当前播放信息推送到 Webhook，支持 Discord 与通用 JSON。
 * @homepage    https://github.com/SPlayer-Dev/plugins
 * @updateUrl   https://raw.githubusercontent.com/SPlayer-Dev/plugins/main/plugins/splayer.now-playing-webhook.js
 * @changelog   首个版本：切歌推送，支持 Discord / 通用 JSON、自定义模板。
 */

splayer.register({
  events: ["trackChange"],
  settings: [
    {
      key: "webhook",
      type: "text",
      label: "Webhook 地址",
      placeholder: "https://discord.com/api/webhooks/...",
      default: "",
    },
    {
      key: "format",
      type: "select",
      label: "推送格式",
      default: "discord",
      options: [
        { label: "Discord Webhook", value: "discord" },
        { label: "通用 JSON", value: "json" },
      ],
    },
    {
      key: "template",
      type: "text",
      label: "消息模板",
      description: "占位符：{title} {artists} {album}",
      default: "🎵 正在收听：{title} - {artists}",
    },
  ],
});

/** 用 track 字段填充模板占位符 */
const render = (tpl, track) =>
  String(tpl || "").replace(/\{(title|artists|album)\}/g, (_, key) => String(track[key] || ""));

/** 本地封面是 cover:// 协议，外部服务取不到，只放行 http(s) */
const httpCover = (cover) =>
  typeof cover === "string" && /^https?:\/\//.test(cover) ? cover : "";

let lastKey = "";

splayer.player.on("trackChange", async ({ track }) => {
  if (!track) {
    lastKey = "";
    return;
  }

  const webhook = String(splayer.getSetting("webhook") || "").trim();
  if (!webhook) return;

  // 去重：同一首歌只推一次（启用补发的快照、重复事件都被过滤）
  const key = track.title + "|" + track.artists;
  if (key === lastKey) return;
  lastKey = key;

  const text = render(splayer.getSetting("template"), track);
  const cover = httpCover(track.cover);
  const format = splayer.getSetting("format") || "discord";

  let body;
  if (format === "discord") {
    const embed = { title: track.title || "", description: track.artists || "" };
    if (track.album) embed.footer = { text: track.album };
    if (cover) embed.thumbnail = { url: cover };
    body = { content: text, embeds: [embed] };
  } else {
    body = {
      text,
      title: track.title || "",
      artists: track.artists || "",
      album: track.album || "",
      cover,
      duration: track.duration || 0,
    };
  }

  try {
    await splayer.request(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    splayer.log.info("Now Playing 已推送：" + track.title);
  } catch (err) {
    splayer.log.warn("Now Playing 推送失败：" + (err && err.message));
  }
});

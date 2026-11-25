/**
 * @name SPTL 任务栏歌词
 * @id zxaBinbina.sptl
 * @version 1.2.1
 * @author zxaBinbina
 * @type control
 * @grant network control api
 * @apiLevel 5
 * @updateUrl https://github.com/zxaBinbina/SplayerPlasmaTaskbarLyrics/releases/latest/download/zxaBinbina.sptl.js
 * @description KDE Plasma 5/6 任务栏同步歌词、封面和播放控制。需安装 SPTL 辅助程序与小部件。
 * @homepage https://github.com/zxaBinbina/SplayerPlasmaTaskbarLyrics
 */
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-License-Identifier: AGPL-3.0-only
(function () {
  "use strict";
  let locale = String(splayer.locale || "zh-CN");
  splayer.register({
    events: ["trackChange", "lyricChange", "lineChange", "playStateChange"],
    controls: true,
    settings: []
  });
  const session = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  let track = null, lines = [], lyricRevision = 0, sentRevision = -1;
  let state = "idle", position = 0, duration = 0, speed = 1, offset = 0, volume = 1;
  let index = -1, busy = false, generation = 0, warned = false;
  let acknowledgements = [], executionResults = [], lastFinishedCommand = 0;
  const modeAvailable = typeof splayer.player.setPlayMode === "function";
  const queueAvailable = typeof splayer.player.getQueue === "function";
  const fmAvailable = queueAvailable && !!splayer.api && typeof splayer.api.call === "function";
  let fmActive = false, fmProbeBusy = false, fmProbeAt = 0;
  const startAvailable = !!splayer.api && typeof splayer.api.call === "function" &&
    typeof splayer.player.playTrack === "function" && typeof splayer.player.addToQueue === "function";
  let queue = {available: queueAvailable, tracks: [], total: 0, currentIndex: -1, offset: 0, requestId: 0, error: ""};
  let repeat = "list", shuffle = "off", commandError = "";
  const handled = new Set();
  const pendingCommands = new Set();
  const commandChains = {};
  const number = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const sameTrack = (a, b) => !!a && !!b && ["id", "source", "path"].every(key => String(a[key] || "") === String(b[key] || ""));
  async function readFm(now, status) {
    if (!now.track || now.track.source !== "netease" || !queueAvailable ||
        (now.state !== "playing" && now.state !== "paused")) return false;
    if (typeof status.fmMode === "boolean") return status.fmMode;
    if (typeof now.fmMode === "boolean") return now.fmMode;
    // SP's native FM pool is separate from its normal queue. Regular online
    // playback inserts the loaded song into that queue before publishing it.
    const selectedIndex = number(status.currentIndex, -1);
    const page = await splayer.player.getQueue({offset: Math.max(0, selectedIndex), limit: 1});
    if (page.currentIndex !== selectedIndex) return false; // Index changed during IPC; retry.
    return !sameTrack(now.track, page.tracks[0]);
  }
  function probeFm(now, status) {
    if (!track || track.source !== "netease" || !queueAvailable) { fmActive = false; return; }
    if (fmProbeBusy || Date.now() - fmProbeAt < 1000) return;
    fmProbeBusy = true;
    fmProbeAt = Date.now();
    const observed = track;
    // Slow queue IPC must never stop lyrics/status exchanges.
    readFm(now, status).then(active => { if (sameTrack(observed, track)) fmActive = active; })
      .catch(() => { if (sameTrack(observed, track)) fmActive = false; })
      .finally(() => { fmProbeBusy = false; });
  }
  async function netease(name, params = {}) {
    const result = await splayer.api.call("netease", name, params);
    const body = result && result.body;
    if (result && (result.status === 301 || (body && body.code === 301))) throw new Error("login_required");
    if (!result || !result.ok || !body || (body.code !== undefined && body.code !== 200))
      throw new Error("control_failed");
    return body;
  }
  function songTrack(song) {
    const album = song.al || song.album;
    return {
      id: String(song.id), source: "netease", title: String(song.name || ""),
      artists: (song.ar || song.artists || []).map(artist => ({id: String(artist.id), name: String(artist.name || "")})),
      album: album ? {id: String(album.id), name: String(album.name || "")} : undefined,
      duration: Math.max(0, number(song.dt, number(song.duration, 0))),
      cover: album && album.picUrl || "", fee: song.fee, cloud: song.pc != null
    };
  }
  async function startLiked() {
    if (!startAvailable) throw new Error("start_unavailable");
    const login = await netease("login_status");
    const account = login.data || login;
    const uid = account.profile && account.profile.userId || account.account && account.account.id;
    if (!uid) throw new Error("login_required");
    const liked = await netease("likelist", {uid});
    const ids = Array.isArray(liked.ids) ? [...new Set(liked.ids.map(String))] : [];
    if (!ids.length) throw new Error("liked_empty");
    const tracks = [];
    // The host resolves playback URLs and credentials. Only song metadata
    // crosses the official API, and no SP database is read or written.
    for (let offset = 0; offset < ids.length; offset += 500) {
      const details = await netease("song_detail", {ids: ids.slice(offset, offset + 500).join(",")});
      const songs = new Map((details.songs || []).map(song => [String(song.id), song]));
      for (const id of ids.slice(offset, offset + 500))
        if (songs.has(id)) tracks.push(songTrack(songs.get(id)));
    }
    if (!tracks.length) throw new Error("liked_empty");
    // Set a deterministic playback order and insert liked songs immediately
    // after the first one. Reverse the batches to preserve the original order
    // with the host's 50-track "next" insertion API.
    await splayer.player.setPlayMode({repeat: "list", shuffle: "off"});
    await splayer.player.playTrack(tracks[0]);
    for (let end = tracks.length; end > 1;) {
      const begin = Math.max(1, end - 50);
      await splayer.player.addToQueue(tracks.slice(begin, end), "next");
      end = begin;
    }
    splayer.player.play();
  }
  function setTrack(next) {
    const changed = !track !== !next || (track && next &&
      (track.id !== next.id || track.source !== next.source || track.path !== next.path));
    track = next;
    duration = next ? number(next.duration, 0) : 0;
    if (changed) {
      fmActive = false; fmProbeAt = 0;
      lines = []; index = -1; position = 0; generation++; lyricRevision++;
    }
  }
  splayer.player.on("trackChange", (data) => { setTrack(data.track); exchange(); });
  splayer.player.on("lyricChange", (data) => { lines = data.lines || []; lyricRevision++; exchange(); });
  splayer.player.on("lineChange", (data) => { index = data.index; position = data.position; });
  splayer.player.on("playStateChange", (data) => {
    state = data.state; position = data.position; generation++; exchange();
  });
  function dispatch(command) {
    if (handled.has(command.id)) {
      if (!pendingCommands.has(command.id)) acknowledgements.push(command.id);
      return;
    }
    // Remember before dispatch so a lost HTTP response cannot repeat a next/previous action.
    handled.add(command.id);
    if (handled.size > 256) handled.delete(handled.values().next().value);
    pendingCommands.add(command.id);
    // Independent controls must not wait for slow queue/network operations.
    // Keep mutations of the same player state ordered.
    const lane = command.action === "queue" ? "queue" :
      ["prev", "next", "seek", "dislike", "queuePlay", "startLiked"].includes(command.action) ? "navigation" :
      command.action === "mode" ? "mode" :
      ["volume", "setVolume"].includes(command.action) ? "volume" : "playback";
    const dependencies = [commandChains[lane] || Promise.resolve()];
    if (command.action === "startLiked") dependencies.push(commandChains.mode || Promise.resolve());
    const task = Promise.all(dependencies).then(async () => {
      try { await execute(command); }
      finally { pendingCommands.delete(command.id); }
    }).catch(() => {
      // A malformed host rejection must not poison this lane's next request.
      pendingCommands.delete(command.id);
      executionResults.push({id: command.id, ok: false, error: "control_failed"});
      acknowledgements.push(command.id);
      if (command.id >= lastFinishedCommand) { lastFinishedCommand = command.id; commandError = "control_failed"; }
    });
    commandChains[lane] = task;
    if (command.action === "startLiked") commandChains.mode = task;
  }
  async function execute(command) {
    let errorCode = "";
    try { switch (command.action) {
      case "prev": splayer.player.prev(); break;
      case "next": splayer.player.next(); break;
      case "toggle": {
        const nextState = command.value === "playing" || command.value === "paused" ? command.value :
          state === "playing" ? "paused" : "playing";
        nextState === "paused" ? splayer.player.pause() : splayer.player.play();
        state = nextState;
        generation++;
        break;
      }
      case "seek":
        if (command.targetTrack && !sameTrack((await splayer.player.getNowPlaying()).track, command.targetTrack))
          throw new Error("control_failed");
        if (Number.isFinite(command.value)) splayer.player.seek(Math.max(0, command.value));
        break;
      case "volume":
        volume = Math.max(0, Math.min(1, volume + number(command.value, 0)));
        splayer.player.setVolume(volume); break;
      case "setVolume":
        if (Number.isFinite(command.value)) {
          volume = Math.max(0, Math.min(1, command.value));
          splayer.player.setVolume(volume);
        }
        break;
      case "startLiked": await startLiked(); break;
      case "dislike": {
        if (!fmAvailable) throw new Error("start_unavailable");
        const [now, status] = await Promise.all([splayer.player.getNowPlaying(), splayer.player.getStatus()]);
        if (!sameTrack(now.track, command.value) || !await readFm(now, status)) throw new Error("fm_changed");
        await netease("fm_trash", {id: String(now.track.id), time: Math.max(0, Math.round(number(now.position, 0) / 1000))});
        const latest = await splayer.player.getNowPlaying();
        if (sameTrack(now.track, latest.track)) splayer.player.next();
        break;
      }
      case "mode":
        if (fmActive) throw new Error("fm_changed");
        await splayer.player.setPlayMode({repeat: command.value === "one" ? "one" : "list",
                                         shuffle: command.value === "shuffle" ? "on" : "off"});
        break;
      case "queue": {
        if (!queueAvailable) throw new Error("queue_unavailable");
        const status = await splayer.player.getStatus();
        const offset = command.value < 0 ? Math.floor(Math.max(0, number(status.currentIndex, 0)) / 50) * 50 : command.value;
        let page = await splayer.player.getQueue({offset, limit: 50});
        if (page.total > 0 && offset >= page.total)
          page = await splayer.player.getQueue({offset: Math.floor((page.total - 1) / 50) * 50, limit: 50});
        if (page.total === 0) page = {...page, offset: 0};
        queue = {...page, available: true, requestId: command.id, error: ""};
        break;
      }
      case "queuePlay": {
        if (!queueAvailable) throw new Error("queue_unavailable");
        const page = await splayer.player.getQueue({offset: command.value.index, limit: 1});
        const selected = page.tracks[0];
        if (!selected || ["id", "source", "path"].some(key => String(selected[key] || "") !== command.value[key]))
          throw new Error("queue_changed");
        await splayer.player.playTrack(selected);
        break;
      }
    } } catch (error) {
      errorCode = ["queue_changed", "queue_unavailable", "login_required", "liked_empty", "start_unavailable", "fm_changed"].includes(error.message) ?
        error.message : error.code === "PERMISSION_DENIED" || error.code === "GRANT_DENIED" ? "start_unavailable" : "control_failed";
      if (command.action === "queue")
        queue = {...queue, requestId: command.id, error: "unavailable"};
    }
    if (command.id >= lastFinishedCommand) { lastFinishedCommand = command.id; commandError = errorCode; }
    executionResults.push({id: command.id, ok: !errorCode, error: errorCode});
    acknowledgements.push(command.id);
  }
  async function exchange() {
    if (busy) return;
    busy = true;
    try {
      const observedGeneration = generation;
      const [now, status] = await Promise.all([
        splayer.player.getNowPlaying(), splayer.player.getStatus()
      ]);
      // Events received while queries were pending are newer than these snapshots.
      if (observedGeneration !== generation) return;
      setTrack(now.track);
      state = now.state;
      position = number(now.position, position);
      duration = number(status.durationMs, duration);
      speed = Math.max(0, number(now.speed, 1));
      offset = number(now.lyricOffsetMs, 0);
      volume = Math.max(0, Math.min(1, number(status.volume, volume)));
      probeFm(now, status);
      repeat = status.repeat === "one" ? "one" : "list";
      shuffle = status.shuffle === "on" ? "on" : "off";
      queue = {...queue, currentIndex: number(status.currentIndex, queue.currentIndex)};
      const revision = lyricRevision;
      const ack = acknowledgements.slice();
      const results = executionResults.slice();
      const payload = {
        protocol: 1, session, locale, lyricRevision: revision,
        playback: {
          state, position, duration, speed, offset, volume, index, repeat, shuffle,
          // Query timestamp is authoritative; do not anchor at HTTP arrival time.
          timestamp: number(now.sendTimestamp, Date.now())
        },
        track, queue, modeAvailable, startAvailable, fmActive, fmAvailable, commandError
      };
      if (sentRevision !== revision) payload.lines = lines;
      const response = await splayer.request("http://127.0.0.1:43827/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SPTL-Client": "plugin" },
        body: JSON.stringify({ ...payload, ack, results }),
        responseType: "json", timeout: 1500
      });
      if (response.status !== 200 || !response.body || response.body.protocol !== 1)
        throw new Error("SPTL bridge: HTTP " + response.status);
      if (response.body.locale && response.body.locale !== locale) {
        locale = response.body.locale;
      }
      warned = false;
      acknowledgements = acknowledgements.filter((id) => !ack.includes(id));
      executionResults = executionResults.filter(result => !results.some(sent => sent.id === result.id));
      sentRevision = response.body.needLines ? -1 : revision;
      for (const command of response.body.commands || []) dispatch(command);
    } catch (error) {
      sentRevision = -1;
      if (!warned) {
        splayer.log.warn("SPTL: 辅助程序连接失败；将自动重连 / Bridge unavailable; retrying", String(error));
        warned = true;
      }
    } finally { busy = false; }
  }
  setInterval(exchange, 300);
  exchange();
})();

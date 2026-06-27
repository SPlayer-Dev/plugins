/**
 * @name        ClassIsland 联动
 * @id          imsyy.classisland
 * @version     1.0.0
 * @author      imsyy
 * @type        control
 * @apiLevel    2
 * @description 把当前歌词推送到 ClassIsland 主界面
 * @homepage    https://github.com/imsyy/SPlayer
 */

splayer.register({ events: ["trackChange", "lineChange"] });

splayer.player.on("lineChange", ({ index }) => {
  splayer.log.info("当前歌词行", index);
});

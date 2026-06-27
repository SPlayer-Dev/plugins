# SPlayer 插件市场

收录 SPlayer-Next 的插件。

## 提交插件

1. 新建 Issue，选「提交插件」模板。
2. 填写 `@id`，把 `.js` 拖进文本框上传，或粘贴脚本 raw 直链。
3. 机器人会自动校验并回贴结果，维护者审核通过后插件进入市场。

更新插件：先提高脚本里的 `@version`，再走一次提交流程即可，用户端会自动检测到新版。

## 脚本头要求

```js
/**
 * @name      插件名
 * @id        yourname.plugin
 * @version   1.0.0
 * @type      control
 * @apiLevel  2
 * @author    you
 * @description 一句话简介
 */
```

`@id` 全局唯一、上架后不可更改。完整开发文档：https://splayer-next.imsyy.top/plugins/

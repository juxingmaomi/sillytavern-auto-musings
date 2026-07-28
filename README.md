# SillyTavern Auto Musings · 漫想库

SillyTavern 第三方前端扩展。聊天空闲一段时间后，它会从种子词或较早的聊天片段中生成一次“漫想”，并用当前聊天的 API 配置主动发送一条回复。

## 功能

- 自动检测聊天空闲状态
- 自定义离开阈值、检查间隔和漫想间隔
- 三档推送倾向：动态、平衡、更主动
- 自定义种子词（一行一个）
- 手动测试与立即检查
- 设置面板状态显示
- 浮动漫想台、未读角标和持久化日志
- 移动端单列布局

## 安装

推荐在 SillyTavern 中打开：

**扩展 → 安装扩展**

粘贴仓库地址：

```text
https://github.com/juxingmaomi/sillytavern-auto-musings
```

安装或更新后刷新 SillyTavern 页面。扩展列表中应显示 **Auto Musings**，页面右下角会出现灯泡按钮。

## 使用提醒

- 扩展会调用当前聊天的生成 API，并可能主动发送消息。
- 初次安装建议先关闭“启用自动漫想”，使用“立即测试一次”确认效果。
- 漫想日志保存在当前酒馆账号的扩展设置中。
- 日志可能包含截取的旧聊天片段；不需要时可在浮动漫想台中清空。

## v1.2.1

- 修复导致 `index.js` 无法解析的模板字符串损坏
- 重建被清空的设置面板 HTML
- 修复乱码标点、状态文本和 CSS 版本注释
- 保留浮动漫想台、日志与种子词配置
- 移除未实际写入世界书的占位开关
- 避免输入种子词时反复重启计时器
- 增强日志内容的 HTML 转义

## 调试

浏览器控制台中可使用：

```js
AutoMusings.getState()
AutoMusings.checkNow()
AutoMusings.test()
AutoMusings.openSettings()
AutoMusings.openConsole()
```

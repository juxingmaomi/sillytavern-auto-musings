# SillyTavern Auto Musings · 漫想库

SillyTavern 前端扩展（third-party extension）。当聊天空闲时自动生成「漫想」内容，并提供可视化控制面板与状态显示。

## 功能

- **启用/关闭自动漫想** 一键开关
- **离开阈值（分钟）** `idleThresholdMinutes`：判定进入空闲状态所需的最短离开时间
- **检查间隔（分钟）** `checkIntervalMinutes`：轮询检查聊天是否空闲的频率
- **漫想间隔（分钟）** `musingIntervalMinutes`：漫想模式下每次生成漫想的间隔
- **推送倾向** `pushMode`：推送策略（如 `dynamic`）
- **手动操作**：立即生成一次漫想 / 立即检查当前聊天是否空闲
- **状态可视化**：漫想中 / 等待推送 / 空闲时长 / 最近事件 / 进入与退出漫想模式提示

## 安装

把本仓库克隆到 SillyTavern 的 `public/scripts/extensions/third-party/auto-musings` 目录：

```bash
git clone https://github.com/juxingmaomi/sillytavern-auto-musings.git auto-musings
```

重启 SillyTavern 前端，在扩展列表中即可看到「Auto Musings」。

## 版本

v1.1.0

## 说明

本仓库 fork/整理自实际运行于本地 SillyTavern 1.16.0 的扩展版本，后续将在此仓库上进行改造。

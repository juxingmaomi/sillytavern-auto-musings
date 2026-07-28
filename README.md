# SillyTavern Auto Musings｜漫想库

为 SillyTavern 设计的第三方扩展。用户离开当前聊天一段时间后，角色会按照原插件的随机来源与推送倾向产生漫想；未发送到聊天正文的漫想可使用单独的副 API 生成，并保存到服务器日志和角色绑定的主世界书。

## v1.3.0 功能

- 保留原作者的三种随机来源：40% 发呆、30% 种子词、30% 旧聊天片段
- 保留原作者的动态／平衡／更主动推送判断
- 上下文可选“原作者默认”或“最近 N 条消息”
- 每条历史消息明确标注 `role=user`、`role=assistant` 和发送者名称
- 种子词可在前端自行填写，一行一个
- 未发送的隐藏漫想使用单独的 Connection Profile
- 隐藏漫想才写入角色绑定的主世界书；正文消息不会重复保存
- 服务端保存完整漫想历史，手机和电脑读取同一份记录
- 悬浮按钮查看漫想、待补发、世界书保存和错误状态
- 服务器关闭期间不触发、不补算；重新启动后需要打开一次酒馆页面重新登记当前聊天

## 安装

仓库地址：

```text
https://github.com/juxingmaomi/sillytavern-auto-musings
```

### 1. 安装前端扩展

在 SillyTavern 中打开：

**扩展 → 安装扩展**

粘贴上面的仓库地址，安装或更新后刷新页面。

### 2. 安装服务端伴侣

服务端伴侣用于关闭手机或电脑页面后继续计时，并把日志真正保存在酒馆服务器。进入 SillyTavern 的 `plugins` 目录，执行：

```bash
git clone https://github.com/juxingmaomi/sillytavern-auto-musings auto-musings
```

确认 `config.yaml` 中启用了：

```yaml
enableServerPlugins: true
```

然后重启 SillyTavern。控制台出现以下内容即表示加载成功：

```text
[Auto Musings Server] Loaded.
```

同一个仓库既可以作为前端扩展安装，也可以克隆到 `plugins/auto-musings` 作为服务端伴侣。

## 首次设置

1. 打开 Auto Musings 设置面板。
2. 选择上下文读取方式。
3. 如选择“最近 N 条消息”，填写需要读取的消息数量。
4. 选择用于隐藏漫想的 Connection Profile。
5. 如果该配置没有保存模型名，在“副 API 模型名”中手动填写。
6. 确认当前角色已经绑定主世界书，再启用自动漫想。

服务端简单版目前支持 **Custom / OpenAI 兼容** Connection Profile。它会使用该配置保存的 `secret-id` 从 SillyTavern 的 `secrets.json` 读取对应 API Key；Key 不会保存进本扩展的设置或日志。

## 运行机制

1. 前端把当前角色、当前聊天、上下文设置和副 API 配置登记给服务端伴侣。
2. 服务端在 SillyTavern 运行期间持续检查离开时间。
3. 达到离开阈值后，按照原插件规则选择漫想来源并判断是否发送。
4. 决定保留时，通过副 API 生成隐藏漫想，写入服务器日志和主世界书。
5. 决定发送时，先保存为“待补发”；当前聊天页面打开后，再使用酒馆当前主 API 生成正文消息。
6. 服务器关闭后所有计时停止，不生成关机期间的虚构念头。

## 上下文身份

最近消息会按照以下形式交给副 API：

```text
--- MESSAGE START ---
role: user
sender: 用户名称
content:
用户说过的话
--- MESSAGE END ---

--- MESSAGE START ---
role: assistant
sender: 角色名称
content:
角色说过的话
--- MESSAGE END ---
```

系统消息和隐藏消息默认不会计入最近 N 条，以减少模型把用户内容误认为自己内容的情况。

## 世界书保存

- 只保存没有发送到聊天正文的隐藏漫想。
- 每天使用一个 `[Auto Musings] 日期 隐藏漫想` 条目，按时间继续追加。
- 条目默认使用关键词触发，关键词为“漫想存档”“隐藏漫想”，不会常驻占用上下文。
- 已发送到正文的消息只保留在聊天和漫想日志中，不重复写入世界书。
- 清空悬浮窗日志不会删除已经写入世界书的内容。

## 日志位置

安装服务端伴侣后，日志位于当前酒馆账号的用户数据目录：

```text
plugin-data/auto-musings/history.jsonl
```

`日志上限数量` 控制前端一次显示多少条，不会自动删除更早的服务器历史。只有点击“清空”并确认后才会清除日志与待补发队列。

## 注意事项

- 服务端插件不受浏览器沙箱保护，只应安装自己信任的代码。
- 多台设备同时打开不同聊天时，最近同步的当前聊天会成为服务端继续漫想的对象。
- 副 API 配置、模型名或 API Key 缺失时，服务端会暂停触发并在面板提示配置。
- 服务端重启后不会补算停机时间，也不会自动恢复旧计时；打开一次酒馆页面即可重新登记。
- 如果只安装前端扩展，仍可使用基本功能，但关闭页面后计时会停止，日志也只使用扩展设置保存。

## 调试

浏览器控制台中可使用：

```js
AutoMusings.getState()
AutoMusings.checkNow()
AutoMusings.test()
AutoMusings.openSettings()
AutoMusings.openConsole()
```

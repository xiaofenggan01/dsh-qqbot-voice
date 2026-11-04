# dsh-qqbot-voice

[![ci](https://github.com/xiaofenggan01/dsh-qqbot-voice/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaofenggan01/dsh-qqbot-voice/actions/workflows/ci.yml)

给你的 QQ 机器人加一个「说话」工具：把一段文字用 **VoxCPM**（面壁 ModelBest）合成语音，并作为 **QQ 语音消息**发出去。

> A voice-reply tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) QQ bots. Text in, QQ voice message out, via VoxCPM TTS.

## 安装

把仓库地址粘进 DSH 桌面版的「插件 → 添加插件」，或者在命令行里：

```bash
dsh plugin --profile desktop add https://github.com/xiaofenggan01/dsh-qqbot-voice
```

`https://…`、`github:xiaofenggan01/dsh-qqbot-voice`、本地路径三种写法都可以——DSH 的 `plugin add` 直接转发给 pnpm，包内只有 JS，**没有构建步骤**，装完即用。

装完补两行配置就能说话（见下方[配置](#配置)）。

## 为什么是插件，而不是改 qqbot

最早这个功能是直接补在 `@tencent-connect/dsh-qqbot` 的 `dist/` 里的——插件一升级就没了。

这个包不碰 qqbot 的任何文件，只依赖两个公开契约：

- `tools` 服务：注册自己的工具，并嵌套调用 `present`
- `present` → `deliverables/presented`：qqbot 监听到后在轮末按扩展名投递，`.wav` 自动走语音通道

所以 **qqbot 升级、重装、换版本都不会影响它**。

## 工作流程

```
模型调用 qqbot_send_voice({ text })
        │
        ├─ POST {baseUrl}/v1/audio/speech   ← SSE 流，base64 WAV 分片
        ├─ 拼接成 WAV（可选：ffmpeg 变声，保持时长）
        ├─ 落盘 ~/.dsh-qqbot/media/*.wav     ← qqbot 投递白名单内
        └─ present(path)                     ← 声明为交付物
                    │
                    └─ qqbot 轮末投递 → QQ 语音消息
```

## 前置条件

| 依赖 | 说明 |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 宿主 |
| `@tencent-connect/dsh-qqbot` ≥ 0.5.0 | 提供 QQ 通道和投递能力 |
| VoxCPM API Key | 面壁开放平台（`platform.modelbest.cn`）申请 |
| ffmpeg | 可选，只有用 `pitchFactor` 变声时需要 |

## 配置

装完在 profile 的 `cordis.patch.yml` 里补配置（参考 [`example.patch.yml`](./example.patch.yml)）：

```yaml
- id: qqbot-voice
  config:
    apiKey: sk-xxxxxxxx
    voice: voice_xxxxxxxxxxxxxxxx
```

`apiKey` 也可以走环境变量 `QQBOT_TTS_API_KEY`，配置文件里就不用放明文。

改配置即时生效，不用重启。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://api.modelbest.cn` | TTS 服务地址（OpenAI 兼容） |
| `apiKey` | `''` | 留空则读环境变量 `QQBOT_TTS_API_KEY` |
| `model` | `VoxCPM2` | 平台当前唯一的语音合成模型 |
| `voice` | `default` | `default` 或控制台音色库里的 `voice_xxx` |
| `maxChars` | `300` | 单条语音字数上限，超出截断 |
| `pitchFactor` | `1` | 变声倍数：>1 升调、<1 降调，1 不变 |
| `refAudioPath` | `''` | 本地参考 WAV，填了就按零样本复刻合成 |
| `present` | `true` | 合成后自动 present；关掉只返回文件路径 |
| `debug` | `false` | 调试日志 |

## 怎么拿到音色

平台的音色只有两种来源：

1. **`default`** —— 自带音色（偏男声）
2. **`voice_xxx`** —— 账号下复刻出来的音色

拿 `voice_xxx` 的步骤：

1. 登录 [platform.modelbest.cn](https://platform.modelbest.cn)
2. 左侧「音色库」→ 上传一段 5–20 秒的干净人声
3. 建好后复制 id（形如 `voice_1a2b3c4d-…`）
4. 填进 `voice`

界面上看不到 id 的话：F12 → Network → 刷新页面 → 找 `GET /api/voices` 的响应，每个音色都有 `id` 字段。

> 音色 id 和 API Key 都是**账号私有**的，不要提交进仓库。本仓库只带占位符。

## 平台能力边界（实测，2026-11）

| 参数 | 实际情况 |
|---|---|
| `voice` | 只接受 `default` 或 `voice_xxx`；传别的名字直接 400 |
| `ref_audio` | 可用，但只接受内联 `data:audio/wav;base64,...`，URL 会被拒 |
| `voice_description` | 接口收，**实测不生效**（同一句话反复测，基频无差异） |
| `response_format` | 只支持 `wav` |
| `speed` | 只接受 1.0，非 1 报 SSE 冲突，等于不可用 |
| 未知参数 | 静默忽略，不报错——所以“传了没反应”很常见 |

变声需求因此落在插件本地：`pitchFactor` 用 `ffmpeg asetrate + atempo` 抬/降音调并保持时长。

## 在 QQ 里触发

工具本身只负责“能发”，**什么时候发**由 prompt 决定。建议在你的 `im-qqbot` 配置里加几条：

```yaml
groupPrompt: |-
  ...
  发语音
  - 对方要语音（「发语音」「念一下」「用声音回」）时，调 qqbot_send_voice，把要说的话放进 text。
  - 语音只念一两句口语，别把长回答整段念出来；没被要求就不主动发语音。
```

## 常见问题

**QQ 里只回文字，没有语音**
先看工具返回的 `delivered` 字段：`false` 说明 `present` 没成功，检查宿主是否在 `mode: code` 下（该模式下嵌套调用需带 parent token），或者直接在 prompt 里让模型自己再调一次 `present`。

**报「路径不在允许范围」**
qqbot 的 `sendFile.restrictPaths` 默认开启，白名单是 `~/.dsh-qqbot/media` + 插件 cwd + `sendFile.extraRoots`。本插件固定落在 `~/.dsh-qqbot/media`，正常不会触发。

**变声没生效**
宿主要能找到 ffmpeg：`FFMPEG_PATH` 环境变量 → `PATH` → Homebrew 常见路径。找不到时插件会记一条 warn 并退回原始音频。

**语音文件越积越多**
qqbot 的媒体清理（默认 24 小时）会回收 `~/.dsh-qqbot/media` 下的文件。

## 验证安装

```bash
# 1. 插件是否装进 profile、能否解析
node -e "import('dsh-qqbot-voice').then(m => console.log(Object.keys(m)))"

# 2. 不联网的冒烟测试（契约 / 参数校验 / 凭据缺失提示）
npm test
```

CI 会在每次 push 时跑 `npm test` + `npm pack --dry-run`，保证「粘地址能装、装完能加载」这两件事不被改坏。

## 开发

```bash
npm install    # 只装 @deepseek-ai/schemastery 用于本地测试
npm test

# 改了源码之后同步到 profile（pnpm 用的是硬链接）
cp -f index.js ~/.dsh/profiles/<profile>/node_modules/dsh-qqbot-voice/index.js
# 再碰一下 profile 的 cordis.patch.yml 触发热重载
```

## License

[MIT](./LICENSE)

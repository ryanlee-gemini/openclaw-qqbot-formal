<div align="center">



<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot Channel Plugin for OpenClaw

**Connect your AI assistant to QQ — private chat, group chat, and rich media, all in one plugin.**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://github.com/tencent-connect/openclaw-qqbot)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<br/>

**[简体中文](README.zh.md) | English**

Scan to join the QQ group chat

<img width="300" height="540" alt="Clipboard_Screenshot_1773047715" src="https://github.com/user-attachments/assets/4d2d2337-229a-42ad-97ab-8a6d0607f296" />


</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔒 **Multi-Scene** | C2C private chat, group @messages, channel messages, channel DMs |
| 🖼️ **Rich Media** | Send & receive images, voice, video, and files |
| 🎙️ **Voice (STT/TTS)** | Speech-to-text transcription & text-to-speech replies |
| ⏰ **Scheduled Push** | Proactive message delivery via scheduled tasks |
| 🔗 **URL Support** | Direct URL sending in private chat (no restrictions) |
| ⌨️ **Typing Indicator** | "Bot is typing..." status shown in real-time |
| 🔄 **Hot Reload** | Install via npm with seamless hot updates |
| 📝 **Markdown** | Full Markdown formatting support |
| 🛠️ **Commands** | Native OpenClaw command integration |

---

## 🚀 Getting Started

### Step 1 — Create a QQ Bot on the QQ Open Platform

1. Go to the [QQ Open Platform](https://q.qq.com/) and **scan the QR code with your phone QQ** to register / log in. If you haven't registered before, scanning will automatically complete the registration and bindyour QQ account.

<img width="3246" height="1886" alt="Clipboard_Screenshot_1772980354" src="https://github.com/user-attachments/assets/d8491859-57e8-47e4-9d39-b21138be54d0" />

2. After scanning, tap **Agree** on your phone — you'll land on the bot configuration page.
3. Click **Create Bot** to create a new QQ bot.

<img width="1982" height="1316" alt="Clipboard_Screenshot_1772980440" src="https://github.com/user-attachments/assets/3ccb494d-6e4d-462c-9218-b4dfd43a254f" />

4. Find **AppID** and **AppSecret** on the bot's page, click **Copy** for each, and save them somewhere safe (e.g., a notepad). **AppSecret is not stored in plaintext — if you leave the page without saving it, you'll have to regenerate a new one.**

<img width="1670" height="1036" alt="Clipboard_Screenshot_1772980413" src="https://github.com/user-attachments/assets/b898d171-5711-4d42-bc07-2de967b119ec" />


> For a step-by-step walkthrough with screenshots, see the [official guide](https://cloud.tencent.com/developer/article/2626045).

> ⚠️ The bot will automatically appear in your QQ message list and send a first message. However, it will reply "The bot has gone to Mars" until you complete the configuration steps below.

### Step 2 — Install the Plugin

**Option A: One-Click Install & Run (Recommended)**

```bash
git clone https://github.com/tencent-connect/openclaw-qqbot.git && cd openclaw-qqbot
bash ./scripts/upgrade-and-run.sh --appid YOUR_APPID --secret YOUR_SECRET
```

The script handles everything: cleanup old plugins → install deps → register plugin → configure channel → start service. Once done, skip to [Step 4](#step-4--start--test).

**Option B: Manual Step-by-Step**

```bash
git clone https://github.com/tencent-connect/openclaw-qqbot.git && cd openclaw-qqbot
npm install --omit=dev
openclaw plugins install .
```

### Step 3 — Configure OpenClaw

**Option 1: CLI Wizard (Recommended)**

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

**Option 2: Edit Config File**

Edit `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "Your AppID",
      "clientSecret": "Your AppSecret"
    }
  }
}
```

### Step 4 — Start & Test

```bash
openclaw gateway
```

Open QQ, find your bot, and send a message!

<div align="center">
<img width="500" alt="Chat Demo" src="https://github.com/user-attachments/assets/b2776c8b-de72-4e37-b34d-e8287ce45de1" />
</div>

---

## 🤖 Multi-Account Setup (Multi-Bot)

Run multiple QQ bots under a single OpenClaw instance.

### Configuration

Edit `~/.openclaw/openclaw.json` and add an `accounts` field under `channels.qqbot`:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "111111111",
      "clientSecret": "secret-of-bot-1",

      "accounts": {
        "bot2": {
          "enabled": true,
          "appId": "222222222",
          "clientSecret": "secret-of-bot-2"
        },
        "bot3": {
          "enabled": true,
          "appId": "333333333",
          "clientSecret": "secret-of-bot-3"
        }
      }
    }
  }
}
```

**Notes:**

- The top-level `appId` / `clientSecret` is the **default account** (accountId = `"default"`)
- Each key under `accounts` (e.g. `bot2`, `bot3`) is the `accountId` for that bot
- Each account can independently configure `enabled`, `name`, `allowFrom`, `systemPrompt`, etc.
- You may also skip the top-level default account and only configure bots inside `accounts`

Add a second bot via CLI (if the framework supports the `--account` parameter):

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

### Sending Messages to a Specific Account's Users

When using `openclaw message send`, specify which bot to use with the `--account` parameter:

```bash
# Send with the default bot (no --account = uses "default")
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# Send with bot2
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target Formats:**

| Format | Description |
|--------|-------------|
| `qqbot:c2c:OPENID` | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat |
| `qqbot:channel:CHANNEL_ID` | Guild channel |

> ⚠️ **Important**: Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot** be used to send messages via Bot B — this will result in a 500 error. Always use the matching bot's `accountId` to send messages to its users.

### How It Works

- When `openclaw gateway` starts, all accounts with `enabled: true` launch their own WebSocket connections
- Each account maintains an independent Token cache (isolated by `appId`), preventing cross-contamination
- Incoming message logs are prefixed with `[qqbot:accountId]` for easy debugging

---

## 🎙️ Voice Configuration (Optional)

### STT (Speech-to-Text) — Transcribe Incoming Voice Messages

STT supports two-level configuration with priority fallback:

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.stt` | Plugin-specific |
| 2 (fallback) | `tools.media.audio.models[0]` | Framework-level |

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "your-provider",
        "model": "your-stt-model"
      }
    }
  }
}
```

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- Set `enabled: false` to disable
- When configured, incoming voice messages are automatically converted (SILK→WAV) and transcribed

### TTS (Text-to-Speech) — Send Voice Messages

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.tts` | Plugin-specific |
| 2 (fallback) | `messages.tts` | Framework-level |

```json
{
  "channels": {
    "qqbot": {
      "tts": {
        "provider": "your-provider",
        "model": "your-tts-model",
        "voice": "your-voice"
      }
    }
  }
}
```

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- `voice` — voice variant
- Set `enabled: false` to disable (default: `true`)
- When configured, AI can use `<qqvoice>` tags to generate and send voice messages

---

## 🔄 Upgrade

### Via OpenClaw / npm

> npm package coming soon. Once published, you can install and upgrade via:
>
> ```bash
> openclaw plugins install openclaw-qqbot@latest
> openclaw plugins upgrade openclaw-qqbot@latest
> ```

### Via upgrade-and-run.sh (One-Click)

```bash
bash ./scripts/upgrade-and-run.sh
```

When no `--appid` / `--secret` is provided, the script reads existing config from `~/.openclaw/openclaw.json` automatically.

```bash
# First-time or override credentials
bash ./scripts/upgrade-and-run.sh --appid YOUR_APPID --secret YOUR_SECRET
```

<details>
<summary>Full Options</summary>

| Option | Description |
|--------|-------------|
| `--appid <id>` | QQ Bot AppID |
| `--secret <secret>` | QQ Bot AppSecret |
| `--markdown <yes\|no>` | Enable Markdown format (default: no) |
| `-h, --help` | Show help |

Environment variables `QQBOT_APPID`, `QQBOT_SECRET`, `QQBOT_TOKEN` (AppID:Secret) are also supported.

</details>

### Via pull-latest.sh (Git Source)

```bash
bash ./scripts/pull-latest.sh
```

<details>
<summary>Options</summary>

```bash
bash ./scripts/pull-latest.sh --branch main            # specify branch (default: main)
bash ./scripts/pull-latest.sh --force                   # skip prompts, force update
bash ./scripts/pull-latest.sh --repo <git-url>          # use a different repo
```

</details>

### From Source

```bash
git clone https://github.com/tencent-connect/openclaw-qqbot.git && cd openclaw-qqbot
npm install --omit=dev
bash ./scripts/upgrade.sh
openclaw plugins install .
openclaw channels add --channel qqbot --token "AppID:AppSecret"
openclaw gateway restart
```

---

## 📸 Rich Media — Full Guide

> **Note:** This plugin serves as a **message channel** only — it relays messages between QQ and OpenClaw. Capabilities like image understanding, voice transcription, drawing, etc. depend on the **AI model** you configure and the **skills** installed in OpenClaw, not on this plugin itself.

<details>
<summary><b>What AI Can Receive</b> — Voice, files, and images can all be understood</summary>

#### Voice Messages (STT)

With STT configured, the plugin automatically transcribes voice messages to text before passing them to AI. The whole process is transparent to the user — sending voice feels as natural as sending text.

STT supports two-level configuration with priority fallback: `channels.qqbot.stt` (plugin-specific) → `tools.media.audio.models[0]` (framework-level fallback). Framework-level example:

```json
{
  "tools": {
    "media": {
      "audio": {
        "models": [
          { "provider": "openai", "model": "FunAudioLLM/SenseVoiceSmall" }
        ]
      }
    }
  }
}
```

`provider` references a key in `models.providers` to inherit `baseUrl` and `apiKey`. Supports any OpenAI-compatible STT API.

> **You**: *(send a voice message)* "What's the weather like tomorrow in Shenzhen?"
>
> **QQBot**: Tomorrow (March 7, Saturday) Shenzhen weather forecast 🌤️ ...

<img width="360" src="docs/images/fc7b2236896cfba3a37c94be5d59ce3e_720.jpg" alt="Voice STT Demo" />

#### File Understanding

Send any file to the bot — novels, reports, spreadsheets — AI automatically recognizes the content and gives an intelligent reply.

> **You**: *(send a TXT file of "War and Peace")*
>
> **QQBot**: Got it! You uploaded the Chinese version of "War and Peace" by Leo Tolstoy. This appears to be the opening of Chapter 1...

<img width="360" src="docs/images/07bff56ab68e03173d2af586eeb3bcee_720.jpg" alt="File Understanding Demo" />

#### Image Understanding

If your main model supports vision (e.g. Tencent Hunyuan `hunyuan-vision`), AI can understand images too. This is a general multimodal capability, not plugin-specific.

> **You**: *(send an image)*
>
> **QQBot**: Haha, so cute! Is that a QQ penguin in a lobster costume? 🦞🐧 ...

<img width="360" src="docs/images/59d421891f813b0d3c0cbe12574b6a72_720.jpg" alt="Image Understanding Demo" />

</details>

<details>
<summary><b>What AI Can Send</b> — Images, voice, files, and videos can all be sent directly</summary>

#### Image

AI writes a `<qqimg>` tag in the reply and the system automatically uploads and sends it. Both local file paths and URLs are supported. Formats: jpg/png/gif/webp/bmp.

> **You**: Draw me a cat
>
> **QQBot**: `<qqimg>~/.openclaw/qqbot/images/cute-cat.png</qqimg>`

<img width="360" src="docs/images/4645f2b3a20822b7f8d6664a708529eb_720.jpg" alt="Image Generation Demo" />

#### Voice (TTS)

With TTS configured, AI can turn text into voice messages.

TTS supports two-level configuration: `channels.qqbot.tts` (plugin-specific) → `messages.tts` (framework-level fallback). Plugin-specific example:

```json
{
  "channels": {
    "qqbot": {
      "tts": { "provider": "openai", "model": "FunAudioLLM/CosyVoice2-0.5B", "voice": "FunAudioLLM/CosyVoice2-0.5B:claire" }
    }
  }
}
```

`provider` references a key in `models.providers` to inherit `baseUrl` and `apiKey`. Use `voice` to select a voice variant. For detailed config, see [Voice Configuration](#-voice-configuration-optional).

> **You**: Tell me a joke in voice
>
> **QQBot**: `<qqvoice>~/.openclaw/qqbot/tts/joke.silk</qqvoice>`

Supports mp3/wav/silk/ogg. Works without ffmpeg.

<img width="360" src="docs/images/21dce8bfc553ce23d1bd1b270e9c516c.jpg" alt="TTS Voice Demo" />

#### File

> **You**: Extract chapter 1 of War and Peace and send it as a file
>
> **QQBot**: `<qqfile>~/.openclaw/qqbot/downloads/war-and-peace-ch1.txt</qqfile>`

PDF, Excel, ZIP, TXT — any format, up to 20MB.

<img width="360" src="docs/images/17cada70df90185d45a2d6dd36e92f2f_720.jpg" alt="File Sending Demo" />

#### Video

> **You**: Send me a demo video
>
> **QQBot**: `<qqvideo>~/.openclaw/qqbot/downloads/demo.mp4</qqvideo>`

Both local files and URLs are supported. Large files (>5MB) auto-show "uploading..." status.

<img width="360" src="docs/images/85d03b8a216f267ab7b2aee248a18a41_720.jpg" alt="Video Sending Demo" />

</details>

<details>
<summary><b>Try It Yourself</b> — Quick demo scenarios</summary>

| Direction | You say | AI does |
|-----------|---------|---------|
| Receive voice | Send a voice message asking about weather | STT auto-transcribes, AI replies with text |
| Receive file | Send a file to the bot | AI reads file content, gives intelligent reply |
| Send image | "Draw me a cat" | Calls drawing tool, sends image back |
| Send voice | "Tell me a joke in voice" | TTS generates voice, sends voice message |
| Send file | "Generate a file for me" | Creates file, sends via `<qqfile>` |
| Send video | "Send me a video" | Sends video via `<qqvideo>` |

</details>

<details>
<summary><b>Under the Hood</b> — Why does it feel so smooth?</summary>

- **Tag auto-correction**: 30+ variants like `<qq_img>`, `<image>`, even full-width `＜qqimg＞` are all auto-corrected to the standard tag
- **Upload caching**: Same file sent to the same target within a short window automatically reuses the last upload result
- **Ordered delivery**: Mixed messages (text + images + voice) are split into a queue and delivered in order; one failure doesn't block the rest
- **Multi-layer fallback**: Audio format conversion tries multiple methods automatically to ensure voice delivery

</details>

**Quick Reference:**

```
Receive  Voice → STT auto-transcribes    File → Auto-download    Image → Vision model
Send     Image → <qqimg>    Voice → <qqvoice>    File → <qqfile>    Video → <qqvideo>
```

---

## 📚 Documentation

- [Command Reference](docs/commands.md) — OpenClaw CLI commands
- [Changelog](CHANGELOG.md) — release notes

---

## ⭐ Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=tencent-connect/openclaw-qqbot&type=date&legend=top-left)](https://www.star-history.com/#tencent-connect/openclaw-qqbot&type=date&legend=top-left)

</div>

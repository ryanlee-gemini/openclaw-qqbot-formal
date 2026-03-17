/**
 * QQ Bot 消息发送模块
 */

import * as path from "path";
import type { ResolvedQQBotAccount } from "./types.js";
import { decodeCronPayload } from "./utils/payload.js";
import {
  getAccessToken, 
  sendC2CMessage, 
  sendChannelMessage, 
  sendGroupMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
  sendC2CVoiceMessage,
  sendGroupVoiceMessage,
  sendC2CVideoMessage,
  sendGroupVideoMessage,
  sendC2CFileMessage,
  sendGroupFileMessage,
} from "./api.js";
import { isAudioFile, audioFileToSilkBase64, waitForFile } from "./utils/audio-convert.js";
import { normalizeMediaTags } from "./utils/media-tags.js";
import { checkFileSize, readFileAsync, fileExistsAsync, isLargeFile, formatFileSize } from "./utils/file-utils.js";
import { isLocalPath as isLocalFilePath, normalizePath, sanitizeFileName } from "./utils/platform.js";
import { MSG } from "./user-messages.js";

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过 1 小时无法被动回复（需改为主动消息）
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/** 限流检查结果 */
export interface ReplyLimitResult {
  /** 是否允许被动回复 */
  allowed: boolean;
  /** 剩余被动回复次数 */
  remaining: number;
  /** 是否需要降级为主动消息（超期或超过次数） */
  shouldFallbackToProactive: boolean;
  /** 降级原因 */
  fallbackReason?: "expired" | "limit_exceeded";
  /** 提示消息 */
  message?: string;
}

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns ReplyLimitResult 限流检查结果
 */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  // 清理过期记录（定期清理，避免内存泄漏）
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }
  
  // 新消息，首次回复
  if (!record) {
    return { 
      allowed: true, 
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }
  
  // 检查是否超过1小时（message_id 过期）
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    // 超过1小时，被动回复不可用，需要降级为主动消息
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: `消息已超过1小时有效期，将使用主动消息发送`,
    };
  }
  
  // 检查是否超过回复次数限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "limit_exceeded",
      message: `该消息已达到1小时内最大回复次数(${MESSAGE_REPLY_LIMIT}次)，将使用主动消息发送`,
    };
  }
  
  return { 
    allowed: true, 
    remaining,
    shouldFallbackToProactive: false,
  };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
export function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
  console.log(`[qqbot] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`);
}

/**
 * 获取消息回复统计信息
 */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of messageReplyTracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: messageReplyTracker.size, totalReplies };
}

/**
 * 获取消息回复限制配置（供外部查询）
 */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
  /** 出站消息的引用索引（ext_info.ref_idx），供引用消息缓存使用 */
  refIdx?: string;
}

/**
 * 解析目标地址
 * 格式：
 *   - openid (32位十六进制) -> C2C 单聊
 *   - group:xxx -> 群聊
 *   - channel:xxx -> 频道
 *   - 纯数字 -> 频道
 */
function parseTarget(to: string): { type: "c2c" | "group" | "channel"; id: string } {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] parseTarget: input=${to}`);
  
  // 去掉 qqbot: 前缀
  let id = to.replace(/^qqbot:/i, "");
  
  if (id.startsWith("c2c:")) {
    const userId = id.slice(4);
    if (!userId || userId.length === 0) {
      const error = `Invalid c2c target format: ${to} - missing user ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: c2c target, user ID=${userId}`);
    return { type: "c2c", id: userId };
  }
  
  if (id.startsWith("group:")) {
    const groupId = id.slice(6);
    if (!groupId || groupId.length === 0) {
      const error = `Invalid group target format: ${to} - missing group ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: group target, group ID=${groupId}`);
    return { type: "group", id: groupId };
  }
  
  if (id.startsWith("channel:")) {
    const channelId = id.slice(8);
    if (!channelId || channelId.length === 0) {
      const error = `Invalid channel target format: ${to} - missing channel ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: channel target, channel ID=${channelId}`);
    return { type: "channel", id: channelId };
  }
  
  // 默认当作 c2c（私聊）
  if (!id || id.length === 0) {
    const error = `Invalid target format: ${to} - empty ID after removing qqbot: prefix`;
    console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
    throw new Error(error);
  }
  
  console.log(`[${timestamp}] [qqbot] parseTarget: default c2c target, ID=${id}`);
  return { type: "c2c", id };
}

// ============ Telegram 风格的结构化媒体发送接口 ============
// 类似 Telegram 的 sendPhoto / sendVoice / sendVideo / sendDocument，
// 每种媒体类型一个独立函数，接收结构化参数，无需标签解析。
// gateway.ts 的 deliver 回调和 sendText 共用这些函数，消除重复代码。

/** 媒体发送的目标上下文（从 deliver 回调或 sendText 中提取） */
export interface MediaTargetContext {
  /** 目标类型 */
  targetType: "c2c" | "group" | "channel";
  /** 目标 ID */
  targetId: string;
  /** QQ Bot 账户配置 */
  account: ResolvedQQBotAccount;
  /** 被动回复消息 ID（可选） */
  replyToId?: string;
  /** 日志前缀（可选，用于区分调用来源） */
  logPrefix?: string;
}

/** 从 OutboundContext 构建 MediaTargetContext */
function buildMediaTarget(ctx: { to: string; account: ResolvedQQBotAccount; replyToId?: string | null }, logPrefix?: string): MediaTargetContext {
  const target = parseTarget(ctx.to);
  return {
    targetType: target.type,
    targetId: target.id,
    account: ctx.account,
    replyToId: ctx.replyToId ?? undefined,
    logPrefix,
  };
}

/** 获取已认证的 access token，失败时抛出异常 */
async function getToken(account: ResolvedQQBotAccount): Promise<string> {
  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }
  return getAccessToken(account.appId, account.clientSecret);
}

/**
 * sendPhoto — 发送图片消息（对齐 Telegram sendPhoto）
 * 
 * 支持三种来源：
 * - 本地文件路径（自动读取转 Base64）
 * - 公网 HTTP/HTTPS URL
 * - Base64 Data URL
 */
export async function sendPhoto(
  ctx: MediaTargetContext,
  imagePath: string,
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const mediaPath = normalizePath(imagePath);
  const isLocal = isLocalFilePath(mediaPath);
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
  const isData = mediaPath.startsWith("data:");

  let imageUrl = mediaPath;

  if (isLocal) {
    if (!(await fileExistsAsync(mediaPath))) {
      return { channel: "qqbot", error: MSG.IMAGE_NOT_FOUND };
    }
    const sizeCheck = checkFileSize(mediaPath);
    if (!sizeCheck.ok) {
      return { channel: "qqbot", error: sizeCheck.error! };
    }
    const fileBuffer = await readFileAsync(mediaPath);
    const ext = path.extname(mediaPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    };
    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      return { channel: "qqbot", error: MSG.IMAGE_FORMAT_UNSUPPORTED(ext) };
    }
    imageUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
    console.log(`${prefix} sendPhoto: local → Base64 (${formatFileSize(fileBuffer.length)})`);
  } else if (!isHttp && !isData) {
    return { channel: "qqbot", error: `不支持的图片来源: ${mediaPath.slice(0, 50)}` };
  }

  try {
    const token = await getToken(ctx.account);
    const localPath = isLocal ? mediaPath : undefined;

    if (ctx.targetType === "c2c") {
      const r = await sendC2CImageMessage(token, ctx.targetId, imageUrl, ctx.replyToId, undefined, localPath);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupImageMessage(token, ctx.targetId, imageUrl, ctx.replyToId);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      // 频道：仅支持公网 URL（Markdown 格式）
      if (isHttp) {
        const r = await sendChannelMessage(token, ctx.targetId, `![](${mediaPath})`, ctx.replyToId);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
      console.log(`${prefix} sendPhoto: channel does not support local/Base64 images`);
      return { channel: "qqbot" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${prefix} sendPhoto failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/**
 * sendVoice — 发送语音消息（对齐 Telegram sendVoice）
 * 
 * 接收本地音频文件路径，自动转换为 SILK 格式后上传。
 */
export async function sendVoice(
  ctx: MediaTargetContext,
  voicePath: string,
  /** 直传格式列表（跳过 SILK 转换），可选 */
  directUploadFormats?: string[],
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const mediaPath = normalizePath(voicePath);

  // 等待文件就绪（TTS 异步生成，文件可能还没写完）
  const fileSize = await waitForFile(mediaPath);
  if (fileSize === 0) {
    return { channel: "qqbot", error: MSG.VOICE_GENERATE_FAILED };
  }

  try {
    const silkBase64 = await audioFileToSilkBase64(mediaPath, directUploadFormats);
    let uploadBase64 = silkBase64;

    if (!uploadBase64) {
      // SILK 转换失败，尝试直传原始文件
      const buf = await readFileAsync(mediaPath);
      uploadBase64 = buf.toString("base64");
      console.log(`${prefix} sendVoice: SILK conversion failed, uploading raw (${formatFileSize(buf.length)})`);
    } else {
      console.log(`${prefix} sendVoice: SILK ready (${fileSize} bytes)`);
    }

    const token = await getToken(ctx.account);

    if (ctx.targetType === "c2c") {
      const r = await sendC2CVoiceMessage(token, ctx.targetId, uploadBase64, ctx.replyToId, undefined, mediaPath);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupVoiceMessage(token, ctx.targetId, uploadBase64, ctx.replyToId);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      const r = await sendChannelMessage(token, ctx.targetId, MSG.VOICE_CHANNEL_UNSUPPORTED, ctx.replyToId);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${prefix} sendVoice failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/**
 * sendVideoMsg — 发送视频消息（对齐 Telegram sendVideo）
 * 
 * 支持公网 URL 和本地文件路径。
 */
export async function sendVideoMsg(
  ctx: MediaTargetContext,
  videoPath: string,
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const mediaPath = normalizePath(videoPath);
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");

  try {
    const token = await getToken(ctx.account);

    if (isHttp) {
      // 公网 URL
      if (ctx.targetType === "c2c") {
        const r = await sendC2CVideoMessage(token, ctx.targetId, mediaPath, undefined, ctx.replyToId);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else if (ctx.targetType === "group") {
        const r = await sendGroupVideoMessage(token, ctx.targetId, mediaPath, undefined, ctx.replyToId);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else {
        const r = await sendChannelMessage(token, ctx.targetId, MSG.VIDEO_CHANNEL_UNSUPPORTED, ctx.replyToId);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
    }

    // 本地文件
    if (!(await fileExistsAsync(mediaPath))) {
      return { channel: "qqbot", error: MSG.VIDEO_NOT_FOUND };
    }
    const sizeCheck = checkFileSize(mediaPath);
    if (!sizeCheck.ok) {
      return { channel: "qqbot", error: sizeCheck.error! };
    }

    const fileBuffer = await readFileAsync(mediaPath);
    const videoBase64 = fileBuffer.toString("base64");
    console.log(`${prefix} sendVideoMsg: local video (${formatFileSize(fileBuffer.length)})`);

    if (ctx.targetType === "c2c") {
      const r = await sendC2CVideoMessage(token, ctx.targetId, undefined, videoBase64, ctx.replyToId, undefined, mediaPath);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupVideoMessage(token, ctx.targetId, undefined, videoBase64, ctx.replyToId);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      const r = await sendChannelMessage(token, ctx.targetId, MSG.VIDEO_CHANNEL_UNSUPPORTED, ctx.replyToId);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${prefix} sendVideoMsg failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/**
 * sendDocument — 发送文件消息（对齐 Telegram sendDocument）
 * 
 * 支持本地文件路径和公网 URL。
 */
export async function sendDocument(
  ctx: MediaTargetContext,
  filePath: string,
): Promise<OutboundResult> {
  const prefix = ctx.logPrefix ?? "[qqbot]";
  const mediaPath = normalizePath(filePath);
  const isHttp = mediaPath.startsWith("http://") || mediaPath.startsWith("https://");
  const fileName = sanitizeFileName(path.basename(mediaPath));

  try {
    const token = await getToken(ctx.account);

    if (isHttp) {
      if (ctx.targetType === "c2c") {
        const r = await sendC2CFileMessage(token, ctx.targetId, undefined, mediaPath, ctx.replyToId, fileName);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else if (ctx.targetType === "group") {
        const r = await sendGroupFileMessage(token, ctx.targetId, undefined, mediaPath, ctx.replyToId, fileName);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      } else {
        const r = await sendChannelMessage(token, ctx.targetId, MSG.FILE_CHANNEL_UNSUPPORTED, ctx.replyToId);
        return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
      }
    }

    // 本地文件
    if (!(await fileExistsAsync(mediaPath))) {
      return { channel: "qqbot", error: MSG.FILE_NOT_FOUND };
    }
    const sizeCheck = checkFileSize(mediaPath);
    if (!sizeCheck.ok) {
      return { channel: "qqbot", error: sizeCheck.error! };
    }
    const fileBuffer = await readFileAsync(mediaPath);
    if (fileBuffer.length === 0) {
      return { channel: "qqbot", error: `文件内容为空: ${mediaPath}` };
    }
    const fileBase64 = fileBuffer.toString("base64");
    console.log(`${prefix} sendDocument: local file (${formatFileSize(fileBuffer.length)})`);

    if (ctx.targetType === "c2c") {
      const r = await sendC2CFileMessage(token, ctx.targetId, fileBase64, undefined, ctx.replyToId, fileName, mediaPath);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else if (ctx.targetType === "group") {
      const r = await sendGroupFileMessage(token, ctx.targetId, fileBase64, undefined, ctx.replyToId, fileName);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    } else {
      const r = await sendChannelMessage(token, ctx.targetId, MSG.FILE_CHANNEL_UNSUPPORTED, ctx.replyToId);
      return { channel: "qqbot", messageId: r.id, timestamp: r.timestamp };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${prefix} sendDocument failed: ${msg}`);
    return { channel: "qqbot", error: msg };
  }
}

/**
 * 发送文本消息
 * - 有 replyToId: 被动回复，1小时内最多回复4次
 * - 无 replyToId: 主动发送，有配额限制（每月4条/用户/群）
 * 
 * 注意：
 * 1. 主动消息（无 replyToId）必须有消息内容，不支持流式发送
 * 2. 当被动回复不可用（超期或超过次数）时，自动降级为主动消息
 * 3. 支持 <qqimg>路径</qqimg> 或 <qqimg>路径</img> 格式发送图片
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, account } = ctx;
  let { text, replyToId } = ctx;
  let fallbackToProactive = false;

  console.log("[qqbot] sendText ctx:", JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

  // ============ 消息回复限流检查 ============
  // 如果有 replyToId，检查是否可以被动回复
  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);
    
    if (!limitCheck.allowed) {
      // 检查是否需要降级为主动消息
      if (limitCheck.shouldFallbackToProactive) {
        console.warn(`[qqbot] sendText: 被动回复不可用，降级为主动消息 - ${limitCheck.message}`);
        fallbackToProactive = true;
        replyToId = null; // 清除 replyToId，改为主动消息
      } else {
        // 不应该发生，但作为保底
        console.error(`[qqbot] sendText: 消息回复被限流但未设置降级 - ${limitCheck.message}`);
        return { 
          channel: "qqbot", 
          error: limitCheck.message 
        };
      }
    } else {
      console.log(`[qqbot] sendText: 消息 ${replyToId} 剩余被动回复次数: ${limitCheck.remaining}/${MESSAGE_REPLY_LIMIT}`);
    }
  }

  // ============ 媒体标签检测与处理 ============
  // 支持四种标签:
  //   <qqimg>路径</qqimg> 或 <qqimg>路径</img>  — 图片
  //   <qqvoice>路径</qqvoice>                   — 语音
  //   <qqvideo>路径或URL</qqvideo>                — 视频
  //   <qqfile>路径</qqfile>                     — 文件
  
  // 预处理：纠正小模型常见的标签拼写错误和格式问题
  text = normalizeMediaTags(text);
  
  const mediaTagRegex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
  const mediaTagMatches = text.match(mediaTagRegex);
  
  if (mediaTagMatches && mediaTagMatches.length > 0) {
    console.log(`[qqbot] sendText: Detected ${mediaTagMatches.length} media tag(s), processing...`);
    
    // 构建发送队列：根据内容在原文中的实际位置顺序发送
    const sendQueue: Array<{ type: "text" | "image" | "voice" | "video" | "file"; content: string }> = [];
    
    let lastIndex = 0;
    const mediaTagRegexWithIndex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
    let match;
    
    while ((match = mediaTagRegexWithIndex.exec(text)) !== null) {
      // 添加标签前的文本
      const textBefore = text.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
      if (textBefore) {
        sendQueue.push({ type: "text", content: textBefore });
      }
      
      const tagName = match[1]!.toLowerCase(); // "qqimg" or "qqvoice" or "qqfile"
      
      // 剥离 MEDIA: 前缀（框架可能注入），展开 ~ 路径
      let mediaPath = match[2]?.trim() ?? "";
      if (mediaPath.startsWith("MEDIA:")) {
        mediaPath = mediaPath.slice("MEDIA:".length);
      }
      mediaPath = normalizePath(mediaPath);

      // 处理可能被模型转义的路径
      // 1. 双反斜杠 -> 单反斜杠（Markdown 转义）
      mediaPath = mediaPath.replace(/\\\\/g, "\\");

      // 2. 八进制转义序列 + UTF-8 双重编码修复
      try {
        const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
        const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

        if (hasOctal || hasNonASCII) {
          console.log(`[qqbot] sendText: Decoding path with mixed encoding: ${mediaPath}`);

          // Step 1: 将八进制转义转换为字节
          let decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
            return String.fromCharCode(parseInt(octal, 8));
          });

          // Step 2: 提取所有字节（包括 Latin-1 字符）
          const bytes: number[] = [];
          for (let i = 0; i < decoded.length; i++) {
            const code = decoded.charCodeAt(i);
            if (code <= 0xFF) {
              bytes.push(code);
            } else {
              const charBytes = Buffer.from(decoded[i], 'utf8');
              bytes.push(...charBytes);
            }
          }

          // Step 3: 尝试按 UTF-8 解码
          const buffer = Buffer.from(bytes);
          const utf8Decoded = buffer.toString('utf8');

          if (!utf8Decoded.includes('\uFFFD') || utf8Decoded.length < decoded.length) {
            mediaPath = utf8Decoded;
            console.log(`[qqbot] sendText: Successfully decoded path: ${mediaPath}`);
          }
        }
      } catch (decodeErr) {
        console.error(`[qqbot] sendText: Path decode error: ${decodeErr}`);
      }

      if (mediaPath) {
        if (tagName === "qqvoice") {
          sendQueue.push({ type: "voice", content: mediaPath });
          console.log(`[qqbot] sendText: Found voice path in <qqvoice>: ${mediaPath}`);
        } else if (tagName === "qqvideo") {
          sendQueue.push({ type: "video", content: mediaPath });
          console.log(`[qqbot] sendText: Found video URL in <qqvideo>: ${mediaPath}`);
        } else if (tagName === "qqfile") {
          sendQueue.push({ type: "file", content: mediaPath });
          console.log(`[qqbot] sendText: Found file path in <qqfile>: ${mediaPath}`);
        } else {
          sendQueue.push({ type: "image", content: mediaPath });
          console.log(`[qqbot] sendText: Found image path in <qqimg>: ${mediaPath}`);
        }
      }
      
      lastIndex = match.index + match[0].length;
    }
    
    // 添加最后一个标签后的文本
    const textAfter = text.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
    if (textAfter) {
      sendQueue.push({ type: "text", content: textAfter });
    }
    
    console.log(`[qqbot] sendText: Send queue: ${sendQueue.map(item => item.type).join(" -> ")}`);
    
    // 按顺序发送（使用 Telegram 风格的统一媒体发送函数）
    const mediaTarget = buildMediaTarget({ to, account, replyToId }, "[qqbot:sendText]");
    let lastResult: OutboundResult = { channel: "qqbot" };
    
    for (const item of sendQueue) {
      try {
        if (item.type === "text") {
          // 发送文本
          if (replyToId) {
            const accessToken = await getToken(account);
            const target = parseTarget(to);
            if (target.type === "c2c") {
              const result = await sendC2CMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
            } else if (target.type === "group") {
              const result = await sendGroupMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
            }
          } else {
            const accessToken = await getToken(account);
            const target = parseTarget(to);
            if (target.type === "c2c") {
              const result = await sendProactiveC2CMessage(accessToken, target.id, item.content);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
            } else if (target.type === "group") {
              const result = await sendProactiveGroupMessage(accessToken, target.id, item.content);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, item.content);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
            }
          }
          console.log(`[qqbot] sendText: Sent text part: ${item.content.slice(0, 30)}...`);
        } else if (item.type === "image") {
          lastResult = await sendPhoto(mediaTarget, item.content);
        } else if (item.type === "voice") {
          lastResult = await sendVoice(mediaTarget, item.content);
        } else if (item.type === "video") {
          lastResult = await sendVideoMsg(mediaTarget, item.content);
        } else if (item.type === "file") {
          lastResult = await sendDocument(mediaTarget, item.content);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[qqbot] sendText: Failed to send ${item.type}: ${errMsg}`);
      }
    }
    
    return lastResult;
  }

  // ============ 主动消息校验（参考 Telegram 机制） ============
  // 如果是主动消息（无 replyToId 或降级后），必须有消息内容
  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      console.error("[qqbot] sendText error: 主动消息的内容不能为空 (text is empty)");
      return { 
        channel: "qqbot", 
        error: "主动消息必须有内容 (--message 参数不能为空)" 
      };
    }
    if (fallbackToProactive) {
      console.log(`[qqbot] sendText: [降级] 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    } else {
      console.log(`[qqbot] sendText: 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    }
  }

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    console.log("[qqbot] sendText target:", JSON.stringify(target));

    // 如果没有 replyToId，使用主动发送接口
    if (!replyToId) {
      let outResult: OutboundResult;
      if (target.type === "c2c") {
        const result = await sendProactiveC2CMessage(accessToken, target.id, text);
        outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
      } else if (target.type === "group") {
        const result = await sendProactiveGroupMessage(accessToken, target.id, text);
        outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
      } else {
        // 频道暂不支持主动消息
        const result = await sendChannelMessage(accessToken, target.id, text);
        outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
      }
      return outResult;
    }

    // 有 replyToId，使用被动回复接口
    if (target.type === "c2c") {
      const result = await sendC2CMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
    } else if (target.type === "group") {
      const result = await sendGroupMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: result.ext_info?.ref_idx };
    } else {
      const result = await sendChannelMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 主动发送消息（不需要 replyToId，有配额限制：每月 4 条/用户/群）
 * 
 * @param account - 账户配置
 * @param to - 目标地址，格式：openid（单聊）或 group:xxx（群聊）
 * @param text - 消息内容
 */
export async function sendProactiveMessage(
  account: ResolvedQQBotAccount,
  to: string,
  text: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  
  if (!account.appId || !account.clientSecret) {
    const errorMsg = "QQBot not configured (missing appId or clientSecret)";
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: ${errorMsg}`);
    return { channel: "qqbot", error: errorMsg };
  }

  console.log(`[${timestamp}] [qqbot] sendProactiveMessage: starting, to=${to}, text length=${text.length}, accountId=${account.accountId}`);

  try {
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: getting access token for appId=${account.appId}`);
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: parsing target=${to}`);
    const target = parseTarget(to);
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: target parsed, type=${target.type}, id=${target.id}`);

    let outResult: OutboundResult;
    if (target.type === "c2c") {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive C2C message to user=${target.id}`);
      const result = await sendProactiveC2CMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive C2C message sent successfully, messageId=${result.id}`);
      outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    } else if (target.type === "group") {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive group message to group=${target.id}`);
      const result = await sendProactiveGroupMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive group message sent successfully, messageId=${result.id}`);
      outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    } else {
      // 频道暂不支持主动消息，使用普通发送
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending channel message to channel=${target.id}`);
      const result = await sendChannelMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: channel message sent successfully, messageId=${result.id}`);
      outResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp, refIdx: (result as any).ext_info?.ref_idx };
    }
    return outResult;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error: ${errorMessage}`);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error stack: ${err instanceof Error ? err.stack : 'No stack trace'}`);
    return { channel: "qqbot", error: errorMessage };
  }
}

/**
 * 发送富媒体消息（图片）
 * 
 * 支持以下 mediaUrl 格式：
 * - 公网 URL: https://example.com/image.png
 * - Base64 Data URL: data:image/png;base64,xxxxx
 * - 本地文件路径: /path/to/image.png（自动读取并转换为 Base64）
 * 
 * @param ctx - 发送上下文，包含 mediaUrl
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * // 发送网络图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "https://example.com/image.png",
 *   account,
 *   replyToId: msgId,
 * });
 * 
 * // 发送 Base64 图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "data:image/png;base64,iVBORw0KGgo...",
 *   account,
 *   replyToId: msgId,
 * });
 * 
 * // 发送本地文件（自动读取并转换为 Base64）
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "/tmp/generated-chart.png",
 *   account,
 *   replyToId: msgId,
 * });
 * ```
 */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account } = ctx;
  const mediaUrl = normalizePath(ctx.mediaUrl);

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }
  if (!mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }

  const target = buildMediaTarget({ to, account, replyToId }, "[qqbot:sendMedia]");
  const isLocal = isLocalFilePath(mediaUrl);
  const isHttp = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");

  // 按类型分发到对应的 Telegram 风格函数
  if (isLocal && isAudioFile(mediaUrl)) {
    const formats = account.config?.audioFormatPolicy?.uploadDirectFormats ?? account.config?.voiceDirectUploadFormats;
    const result = await sendVoice(target, mediaUrl, formats);
    if (!result.error && text?.trim()) await sendTextAfterMedia(target, text);
    return result;
  }
  if (isVideoFile(mediaUrl)) {
    const result = await sendVideoMsg(target, mediaUrl);
    if (!result.error && text?.trim()) await sendTextAfterMedia(target, text);
    return result;
  }
  if (isLocal && !isImageFile(mediaUrl) && !isAudioFile(mediaUrl)) {
    const result = await sendDocument(target, mediaUrl);
    if (!result.error && text?.trim()) await sendTextAfterMedia(target, text);
    return result;
  }

  // 默认：图片
  const result = await sendPhoto(target, mediaUrl);
  if (!result.error && text?.trim()) await sendTextAfterMedia(target, text);
  return result;
}

/** 发送媒体后附带文本说明 */
async function sendTextAfterMedia(ctx: MediaTargetContext, text: string): Promise<void> {
  try {
    const token = await getToken(ctx.account);
    if (ctx.targetType === "c2c") {
      await sendC2CMessage(token, ctx.targetId, text, ctx.replyToId);
    } else if (ctx.targetType === "group") {
      await sendGroupMessage(token, ctx.targetId, text, ctx.replyToId);
    }
  } catch (err) {
    console.error(`[qqbot] sendTextAfterMedia failed: ${err}`);
  }
}

/** 判断文件是否为图片格式 */
function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
}

/** 判断文件/URL 是否为视频格式 */
function isVideoFile(filePath: string): boolean {
  const cleanPath = filePath.split("?")[0]!;
  const ext = path.extname(cleanPath).toLowerCase();
  return [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"].includes(ext);
}

/**
 * 发送 Cron 触发的消息
 * 
 * 当 OpenClaw cron 任务触发时，消息内容可能是：
 * 1. QQBOT_CRON:{base64} 格式的结构化载荷 - 解码后根据 targetType 和 targetAddress 发送
 * 2. 普通文本 - 直接发送到指定目标
 * 
 * @param account - 账户配置
 * @param to - 目标地址（作为后备，如果载荷中没有指定）
 * @param message - 消息内容（可能是 QQBOT_CRON: 格式或普通文本）
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * // 处理结构化载荷
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",  // 后备地址
 *   "QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs..."  // Base64 编码的载荷
 * );
 * 
 * // 处理普通文本
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",
 *   "这是一条普通的提醒消息"
 * );
 * ```
 */
export async function sendCronMessage(
  account: ResolvedQQBotAccount,
  to: string,
  message: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] sendCronMessage: to=${to}, message length=${message.length}`);
  
  // 检测是否是 QQBOT_CRON: 格式的结构化载荷
  const cronResult = decodeCronPayload(message);
  
  if (cronResult.isCronPayload) {
    if (cronResult.error) {
      console.error(`[${timestamp}] [qqbot] sendCronMessage: cron payload decode error: ${cronResult.error}`);
      return {
        channel: "qqbot",
        error: `Cron 载荷解码失败: ${cronResult.error}`
      };
    }
    
    if (cronResult.payload) {
      const payload = cronResult.payload;
      console.log(`[${timestamp}] [qqbot] sendCronMessage: decoded cron payload, targetType=${payload.targetType}, targetAddress=${payload.targetAddress}, content length=${payload.content.length}`);
      
      // 使用载荷中的目标地址和类型发送消息
      const targetTo = payload.targetType === "group" 
        ? `group:${payload.targetAddress}` 
        : payload.targetAddress;
      
      console.log(`[${timestamp}] [qqbot] sendCronMessage: sending proactive message to targetTo=${targetTo}`);
      
      // 发送提醒内容
      const result = await sendProactiveMessage(account, targetTo, payload.content);
      
      if (result.error) {
        console.error(`[${timestamp}] [qqbot] sendCronMessage: proactive message failed, error=${result.error}`);
      } else {
        console.log(`[${timestamp}] [qqbot] sendCronMessage: proactive message sent successfully`);
      }
      
      return result;
    }
  }
  
  // 非结构化载荷，作为普通文本处理
  console.log(`[${timestamp}] [qqbot] sendCronMessage: plain text message, sending to ${to}`);
  return await sendProactiveMessage(account, to, message);
}

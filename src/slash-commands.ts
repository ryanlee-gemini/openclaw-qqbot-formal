/**
 * QQ Bot 斜杠指令处理模块
 *
 * 支持的指令：
 * - /echo <message>    直接回复消息（不经过 AI）
 * - /debug             切换 debug 模式（开启后附带链路耗时统计）
 */

import type { ResolvedQQBotAccount } from "./types.js";
import {
  getAccessToken,
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  clearTokenCache,
} from "./api.js";

// ============ Debug 模式管理 ============

/** 每个会话（peerId）独立的 debug 开关 */
const debugSessions = new Map<string, boolean>();

export function isDebugEnabled(peerId: string): boolean {
  return debugSessions.get(peerId) === true;
}

export function setDebugEnabled(peerId: string, enabled: boolean): void {
  if (enabled) {
    debugSessions.set(peerId, true);
  } else {
    debugSessions.delete(peerId);
  }
}

// ============ 链路耗时追踪 ============

export interface TimingTrace {
  /** QQ 平台事件时间戳 */
  eventTimestamp?: string;
  /** 收到 QQ WebSocket 消息的时间 */
  messageReceivedAt: number;
  /** 发送给 OpenClaw 的时间 */
  dispatchToOpenClawAt?: number;
  /** 消息发送完成的时间 */
  sendCompleteAt?: number;

  // ---- 附加诊断信息 ----
  /** 消息场景（c2c / group / guild / dm） */
  messageType?: string;
  /** 是否包含附件 */
  hasAttachments?: boolean;
  /** 附件类型（如 image, voice, file） */
  attachmentTypes?: string[];
  /** 是否执行了 STT 转录 */
  sttUsed?: boolean;
  /** tool 调用次数 */
  toolCallCount?: number;
  /** 处理过程中的错误信息 */
  errors?: string[];
  /** 用户原始输入（debug 诊断用） */
  userQuery?: string;
  /** 传给 AI 的 agentBody 长度 */
  agentBodyLength?: number;
  /** AI 是否产生了回复（deliver 回调是否被调用） */
  hasResponse?: boolean;
  /** AI 是否产生了面向用户的 block 回复 */
  hasBlockResponse?: boolean;
}

/** 格式化耗时统计为可读文本 */
export function formatTimingTrace(trace: TimingTrace): string {
  const lines: string[] = ["📊 Debug 诊断信息"];

  // 基本信息
  if (trace.messageType) {
    lines.push(`📨 消息类型: ${trace.messageType}`);
  }
  if (trace.hasAttachments && trace.attachmentTypes?.length) {
    lines.push(`📎 附件: ${trace.attachmentTypes.join(", ")}`);
  }
  if (trace.sttUsed) {
    lines.push(`🎙️ STT: 已转录`);
  }

  // 链路耗时
  lines.push("⏱ 链路耗时");
  const t0 = trace.messageReceivedAt;

  const eventTs = trace.eventTimestamp ? new Date(trace.eventTimestamp).getTime() : 0;
  const platformDelay = eventTs > 0 ? `${t0 - eventTs}ms` : "N/A";
  lines.push(`├ 平台→QQBot插件: ${platformDelay}`);

  if (trace.dispatchToOpenClawAt) {
    lines.push(`├ QQBot插件耗时: ${trace.dispatchToOpenClawAt - t0}ms`);
  }
  if (trace.sendCompleteAt && trace.dispatchToOpenClawAt) {
    lines.push(`└ OpenClaw耗时: ${trace.sendCompleteAt - trace.dispatchToOpenClawAt}ms`);
  }

  // tool 调用
  if (trace.toolCallCount && trace.toolCallCount > 0) {
    lines.push(`🔧 Tool 调用: ${trace.toolCallCount} 次`);
  }

  // 错误信息
  if (trace.errors?.length) {
    lines.push(`❌ 错误 (${trace.errors.length}):`);
    for (const err of trace.errors) {
      lines.push(`  · ${err.slice(0, 150)}`);
    }
  }

  // 用户输入摘要（便于确认 query 是否正确传递给 AI）
  if (trace.userQuery !== undefined) {
    const queryPreview = trace.userQuery
      ? trace.userQuery.slice(0, 100) + (trace.userQuery.length > 100 ? "..." : "")
      : "(空)";
    lines.push(`📝 用户输入: ${queryPreview}`);
  }

  return lines.join("\n");
}

// ============ 斜杠指令解析 ============

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
}

interface SendContext {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  groupOpenid?: string;
  account: ResolvedQQBotAccount;
  peerId: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/** 发送带 token 重试的消息 */
async function sendReply(ctx: SendContext, text: string): Promise<void> {
  const { type, senderId, messageId, channelId, groupOpenid, account } = ctx;

  const send = async (token: string) => {
    if (type === "c2c") {
      await sendC2CMessage(token, senderId, text, messageId);
    } else if (type === "group" && groupOpenid) {
      await sendGroupMessage(token, groupOpenid, text, messageId);
    } else if (channelId) {
      await sendChannelMessage(token, channelId, text, messageId);
    }
  };

  try {
    const token = await getAccessToken(account.appId, account.clientSecret);
    await send(token);
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
      clearTokenCache(account.appId);
      const newToken = await getAccessToken(account.appId, account.clientSecret);
      await send(newToken);
    } else {
      throw err;
    }
  }
}

// ============ 指令处理 ============

/** 处理 /echo 指令 */
async function handleEcho(ctx: SendContext, args: string, receivedAt: number, eventTimestamp?: string): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }

  // 计算事件时间戳 → 插件收到消息的延迟（QQ 平台 → WebSocket 传输耗时）
  const eventTs = eventTimestamp ? new Date(eventTimestamp).getTime() : 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";

  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→QQBot插件: ${platformDelay}`,
    `└ QQBot插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");

  await sendReply(ctx, timing);
}

/** 处理 /debug 指令 */
async function handleDebug(ctx: SendContext): Promise<void> {
  const current = isDebugEnabled(ctx.peerId);
  const next = !current;
  setDebugEnabled(ctx.peerId, next);

  const status = next
    ? "🔍 Debug 模式已开启\n后续消息回复将附带链路耗时统计"
    : "🔕 Debug 模式已关闭";
  await sendReply(ctx, status);
}

// ============ 指令分发 ============

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  ctx: SendContext,
  receivedAt?: number,
  eventTimestamp?: string,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  // 解析指令名和参数
  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  ctx.log?.info(`[qqbot:${ctx.account.accountId}] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt ?? Date.now(), eventTimestamp);
        return { handled: true };

      case "/debug":
        await handleDebug(ctx);
        return { handled: true };

      default:
        // 不是已知指令，交给 AI 处理
        return { handled: false };
    }
  } catch (err) {
    ctx.log?.error(`[qqbot:${ctx.account.accountId}] Slash command error: ${err}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true };
  }
}

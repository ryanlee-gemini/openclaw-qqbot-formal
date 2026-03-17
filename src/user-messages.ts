/**
 * 用户面向的提示文案集中管理
 *
 * 设计原则（参考 Telegram / Discord / Slack / 飞书）：
 * 1. 禁止暴露服务器路径、原始 Error、配置文件结构
 * 2. 错误信息分级：用户只看到通用友好文案，技术细节走日志
 * 3. 统一风格：去掉 [QQBot] 前缀和 [方括号] 格式
 * 4. 所有面向用户的文案集中在此文件，便于维护和国际化
 */

// ============ 媒体发送错误 ============

export const MSG = {
  // 通用错误
  GENERIC_ERROR: "抱歉，处理消息时遇到了问题，请稍后再试～",
  AI_AUTH_ERROR: "抱歉，AI 服务暂时不可用，请联系管理员检查配置～",
  AI_PROCESS_ERROR: "抱歉，AI 处理遇到了问题，请稍后再试～",
  TIMEOUT_HINT: "已收到消息，正在处理中…",

  // 图片
  IMAGE_NOT_FOUND: "抱歉，图片不存在或已失效，无法发送～",
  IMAGE_FORMAT_UNSUPPORTED: (ext: string) => `抱歉，暂不支持 ${ext} 格式的图片～`,
  IMAGE_SEND_FAILED: "抱歉，图片发送失败了，请稍后再试～",
  IMAGE_UPLOADING: (size: string) => `正在上传图片 (${size})...`,

  // 语音
  VOICE_GENERATE_FAILED: "抱歉，语音生成失败，请稍后重试～",
  VOICE_CONVERT_FAILED: "抱歉，语音格式转换失败，请稍后重试～",
  VOICE_SEND_FAILED: "抱歉，语音发送失败了，请稍后再试～",
  VOICE_NOT_AVAILABLE: "抱歉，语音功能暂未开启～",
  VOICE_MISSING_TEXT: "抱歉，语音消息缺少内容～",
  VOICE_CHANNEL_UNSUPPORTED: "抱歉，语音消息暂不支持在频道中发送～",

  // 视频
  VIDEO_NOT_FOUND: "抱歉，视频文件不存在或已失效，无法发送～",
  VIDEO_SEND_FAILED: "抱歉，视频发送失败了，请稍后再试～",
  VIDEO_MISSING_PATH: "抱歉，视频消息缺少内容～",
  VIDEO_CHANNEL_UNSUPPORTED: "抱歉，视频消息暂不支持在频道中发送～",
  VIDEO_UPLOADING: (size: string) => `正在上传视频 (${size})...`,

  // 文件
  FILE_NOT_FOUND: "抱歉，文件不存在或已失效，无法发送～",
  FILE_SEND_FAILED: "抱歉，文件发送失败了，请稍后再试～",
  FILE_MISSING_PATH: "抱歉，文件消息缺少内容～",
  FILE_CHANNEL_UNSUPPORTED: "抱歉，文件消息暂不支持在频道中发送～",
  FILE_UPLOADING: (name: string, size: string) => `正在上传文件 ${name} (${size})...`,

  // 载荷解析
  PAYLOAD_PARSE_ERROR: "抱歉，消息格式异常，无法处理～",
  UNSUPPORTED_MEDIA_TYPE: "抱歉，暂不支持该媒体类型～",
  UNSUPPORTED_PAYLOAD_TYPE: "抱歉，暂不支持该消息类型～",

  // 工具调用兜底
  TOOL_CALLING: "正在调用工具…",
} as const;

/**
 * 将媒体上传/发送错误转为对用户友好的提示文案
 * 技术细节不暴露给用户，仅记录到日志
 */
export function formatMediaErrorMessage(mediaType: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("上传超时") || msg.includes("timeout") || msg.includes("Timeout")) {
    return `抱歉，${mediaType}资源加载超时，可能是网络原因或文件太大，请稍后再试～`;
  }
  if (msg.includes("文件不存在") || msg.includes("not found") || msg.includes("Not Found")) {
    return `抱歉，${mediaType}文件不存在或已失效，无法发送～`;
  }
  if (msg.includes("文件大小") || msg.includes("too large") || msg.includes("exceed")) {
    return `抱歉，${mediaType}文件太大了，超出了发送限制～`;
  }
  if (msg.includes("Network error") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
    return `抱歉，网络连接异常，${mediaType}发送失败，请稍后再试～`;
  }
  return `抱歉，${mediaType}发送失败了，请稍后再试～`;
}

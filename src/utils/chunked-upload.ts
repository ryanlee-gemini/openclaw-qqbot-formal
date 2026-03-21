/**
 * 大文件分片上传模块
 * 
 * 流程（对照序列图）：
 * 1. 申请上传 (upload_prepare) → 获取 upload_id + block_size + 分片预签名链接
 * 2. 并行上传所有分片：
 *    对于每个分片 i（并行执行，但分片内部串行）：
 *      a. 读取文件的第 i 块数据
 *      b. PUT 到预签名 URL (COS)
 *      c. 调用 upload_part_finish 通知开放平台分片 i 已完成
 * 3. 所有分片完成后，调用完成文件上传接口 → 获取 file_info
 * 
 * 注意：N 个分片之间是并行的，但每个分片的"上传 + 完成"是串行的。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import {
  type MediaFileType,
  type UploadPrepareResponse,
  type MediaUploadResponse,
  c2cUploadPrepare,
  c2cUploadPartFinish,
  c2cCompleteUpload,
  getAccessToken,
} from "../api.js";
import { formatFileSize } from "./file-utils.js";

/** 分片上传并发控制：最多同时上传 N 个分片 */
const MAX_CONCURRENT_PARTS = 5;

/** 单个分片上传超时（毫秒） */
const PART_UPLOAD_TIMEOUT = 120_000;

/** 单个分片上传最大重试次数 */
const PART_UPLOAD_MAX_RETRIES = 2;

/** 分片上传进度回调 */
export interface ChunkedUploadProgress {
  /** 当前已完成分片数 */
  completedParts: number;
  /** 总分片数 */
  totalParts: number;
  /** 已上传字节数 */
  uploadedBytes: number;
  /** 总字节数 */
  totalBytes: number;
}

/** 分片上传选项 */
export interface ChunkedUploadOptions {
  /** 进度回调 */
  onProgress?: (progress: ChunkedUploadProgress) => void;
  /** 最大并发数（默认 5） */
  maxConcurrent?: number;
  /** 日志前缀 */
  logPrefix?: string;
}

/**
 * C2C 大文件分片上传
 * 
 * @param appId - 应用 ID
 * @param clientSecret - 应用密钥
 * @param userId - 用户 openid
 * @param filePath - 本地文件路径
 * @param fileType - 文件类型（1=图片, 2=视频, 3=语音, 4=文件）
 * @param options - 上传选项
 * @returns 上传结果（包含 file_info 可直接用于发送消息）
 */
export async function chunkedUploadC2C(
  appId: string,
  clientSecret: string,
  userId: string,
  filePath: string,
  fileType: MediaFileType,
  options?: ChunkedUploadOptions,
): Promise<MediaUploadResponse> {
  const prefix = options?.logPrefix ?? "[chunked-upload]";
  const maxConcurrent = options?.maxConcurrent ?? MAX_CONCURRENT_PARTS;

  // 1. 读取文件信息
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;
  const fileName = filePath.split(/[/\\]/).pop() ?? "file";

  console.log(`${prefix} Starting chunked upload: file=${fileName}, size=${formatFileSize(fileSize)}, type=${fileType}`);

  // 2. 申请上传 → 获取 upload_id + block_size + 预签名链接
  const accessToken = await getAccessToken(appId, clientSecret);
  const prepareResp = await c2cUploadPrepare(accessToken, userId, fileType, fileName, fileSize);
  const { upload_id, block_size, parts } = prepareResp;

  console.log(`${prefix} Upload prepared: upload_id=${upload_id}, block_size=${formatFileSize(block_size)}, parts=${parts.length}`);

  // 3. 并行上传所有分片（带并发控制）
  let completedParts = 0;
  let uploadedBytes = 0;

  const uploadPart = async (part: { index: number; presigned_url: string }): Promise<void> => {
    const partIndex = part.index;
    // 计算本分片在文件中的偏移和长度
    const offset = (partIndex - 1) * block_size;
    const length = Math.min(block_size, fileSize - offset);

    // 读取分片数据
    const partBuffer = await readFileChunk(filePath, offset, length);

    // 计算 MD5
    const md5Hex = crypto.createHash("md5").update(partBuffer).digest("hex");

    console.log(`${prefix} Part ${partIndex}/${parts.length}: uploading ${formatFileSize(length)} (offset=${offset}, md5=${md5Hex})`);

    // a. PUT 到预签名 URL（带重试）
    await putToPresignedUrl(part.presigned_url, partBuffer, prefix, partIndex, parts.length);

    // b. 通知开放平台分片上传完成（需要重新获取 token，避免长时间上传后 token 过期）
    const token = await getAccessToken(appId, clientSecret);
    await c2cUploadPartFinish(token, userId, upload_id, partIndex, md5Hex);

    // 更新进度
    completedParts++;
    uploadedBytes += length;
    console.log(`${prefix} Part ${partIndex}/${parts.length}: completed (${completedParts}/${parts.length})`);

    if (options?.onProgress) {
      options.onProgress({
        completedParts,
        totalParts: parts.length,
        uploadedBytes,
        totalBytes: fileSize,
      });
    }
  };

  // 并发控制：同时最多执行 maxConcurrent 个分片上传
  await runWithConcurrency(
    parts.map(part => () => uploadPart(part)),
    maxConcurrent,
  );

  console.log(`${prefix} All ${parts.length} parts uploaded successfully, completing upload...`);

  // 4. 完成文件上传
  const finalToken = await getAccessToken(appId, clientSecret);
  const result = await c2cCompleteUpload(finalToken, userId, upload_id);

  console.log(`${prefix} Upload completed: file_uuid=${result.file_uuid}, ttl=${result.ttl}s`);

  return result;
}

/**
 * 读取文件的指定区间（分片）
 */
async function readFileChunk(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    if (bytesRead < length) {
      // 文件末尾，返回实际读取的部分
      return buffer.subarray(0, bytesRead);
    }
    return buffer;
  } finally {
    await fd.close();
  }
}

/**
 * PUT 分片数据到预签名 URL（带重试）
 */
async function putToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  prefix: string,
  partIndex: number,
  totalParts: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PART_UPLOAD_TIMEOUT);

      try {
        // 将 Buffer 转为标准 ArrayBuffer 再包装为 Blob，兼容 bun-types 类型定义
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        const response = await fetch(presignedUrl, {
          method: "PUT",
          body: new Blob([ab]),
          headers: {
            "Content-Length": String(data.length),
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`COS PUT failed: ${response.status} ${response.statusText} - ${body}`);
        }

        return; // 成功
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (lastError.name === "AbortError") {
        lastError = new Error(`Part ${partIndex}/${totalParts} upload timeout after ${PART_UPLOAD_TIMEOUT}ms`);
      }

      if (attempt < PART_UPLOAD_MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`${prefix} Part ${partIndex}/${totalParts}: attempt ${attempt + 1} failed (${lastError.message}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

/**
 * 带并发限制的异步任务执行器
 * 同时最多执行 maxConcurrent 个任务，任一任务失败后不再启动新任务
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  maxConcurrent: number,
): Promise<void> {
  const results: Promise<void>[] = [];
  const executing: Set<Promise<void>> = new Set();
  let hasError = false;

  for (const task of tasks) {
    if (hasError) break; // 已有失败，不再启动新任务

    const p = task().then(
      () => { executing.delete(p); },
      (err) => { executing.delete(p); hasError = true; throw err; },
    );
    results.push(p);
    executing.add(p);

    if (executing.size >= maxConcurrent) {
      // 等待任意一个完成（忽略此处的 reject，最终由 Promise.all 统一抛出）
      await Promise.race(executing).catch(() => {});
    }
  }

  // 等待所有已启动的任务完成（如有失败会抛出第一个错误）
  await Promise.all(results);
}

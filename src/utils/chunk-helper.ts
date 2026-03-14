/**
 * Markdown 文本分块器
 *
 * 按行遍历文本，在代码块边界自动闭合/重开，在表格边界补全表头。
 * 所有长度判断使用 UTF-8 字节数（QQ API 按字节截断）。
 */

import { Buffer } from "node:buffer";

/** 表格分隔行正则，匹配如 |---|---| 或 | :---: | ---: | 等 */
const TABLE_SEP_RE = /^\|[\s\-:|]+\|$/;
/** 代码块闭合重开所需的固定开销字节数：换行符 + ``` */
const FENCE_FIXED_LEN = 4;

/** 计算字符串的 UTF-8 字节长度 */
function byteLen(str: string): number {
  return Buffer.byteLength(str, "utf-8");
}

/** 判断一行是否为表格分隔行 */
function isTableSepLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && TABLE_SEP_RE.test(t);
}

/**
 * 从分隔行（sepIdx）的下一行开始向下扫描，
 * 返回所有数据行的字节总数（含换行符）。
 * 遇到空行或非管道行时停止，表示表格结束。
 */
function measureTable(lines: string[], sepIdx: number): number {
  let bytes = 0;
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // 非管道行或空行，表格结束
    if (line.trim() === "" || !line.trim().startsWith("|")) break;
    bytes += byteLen(line) + 1;
  }
  return bytes;
}

/** 分块过程中的可变状态 */
interface ChunkContext {
  chunks: string[];
  inCode: boolean;
  lang: string;
  tableHeader: string | null;
  current: string;
}

/**
 * 产出当前块并初始化新块。
 * - 若在代码块内，先闭合当前块（追加 \n```），再在新块头部重开（```lang\n）
 * - 若存在 tableHeader，补全到新块头部（前提是不超过 limit）
 */
function finishChunk(ctx: ChunkContext, limit: number): void {
  if (!ctx.current) return;
  if (ctx.inCode) ctx.current += "\n```";
  ctx.chunks.push(ctx.current);
  ctx.current = "";
  if (ctx.inCode) ctx.current = "```" + ctx.lang;
  if (ctx.tableHeader && !ctx.inCode) {
    if (byteLen(ctx.tableHeader) + 1 <= limit) {
      ctx.current += ctx.tableHeader;
    }
  }
}

/**
 * 检测表格起始（表头行 + 分隔行），向前扫描整个表格大小来决定是否提前分割。
 * - 表格能完整放入当前块 → 不分割
 * - 当前块放不下但表格本身不超过 limit → 提前 finishChunk，让表格在新块中保持完整
 * - 表格本身超过 limit → 不提前分割，交由主循环的 wouldExceed 做 mid-table 分割（并补全表头）
 */
function trySplitTable(
  ctx: ChunkContext,
  line: string,
  nextLine: string | undefined,
  sepIdx: number,
  lines: string[],
  limit: number,
): void {
  if (ctx.inCode || !line.includes("|") || !nextLine) return;
  if (!isTableSepLine(nextLine)) return;
  ctx.tableHeader = null;
  const headerBytes = byteLen(line) + 1 + byteLen(nextLine) + 1;
  const tableBytes = headerBytes + measureTable(lines, sepIdx);
  if (
    ctx.current &&
    tableBytes < limit &&
    byteLen(ctx.current) + tableBytes > limit
  ) {
    finishChunk(ctx, limit);
  }
}

/**
 * 遇到 ``` 开头的行时切换代码块开启/闭合状态。
 * 闭合时清除 lang 和 tableHeader；开启时记录语言标识。
 */
function updateFenceState(ctx: ChunkContext, line: string): void {
  const fenced = line.match(/^```(\S*)/);
  if (!fenced) return;
  if (ctx.inCode) {
    ctx.inCode = false;
    ctx.lang = "";
    // 离开代码块，清除残留表头
    ctx.tableHeader = null;
  } else {
    ctx.inCode = true;
    ctx.lang = fenced[1];
  }
}

/**
 * 将 Markdown 文本按字节限制分块。
 * 保证代码块在分块边界处正确闭合/重开，表格在分块边界处补全表头。
 */
export function chunkText(text: string, limit: number): string[] {
  if (byteLen(text) <= limit) return [text];

  const lines = text.split("\n");
  const ctx: ChunkContext = {
    chunks: [],
    inCode: false,
    lang: "",
    tableHeader: null,
    current: "",
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 尝试在表头处提前分割
    trySplitTable(ctx, line, lines[i + 1], i + 1, lines, limit);

    // 预留代码块闭合开销，判断追加当前行是否会超限
    const closeOverhead = ctx.inCode ? FENCE_FIXED_LEN : 0;
    const wouldExceed = byteLen(ctx.current) + byteLen(line) + 1 + closeOverhead > limit;
    if (wouldExceed && ctx.current) finishChunk(ctx, limit);

    ctx.current += ctx.current ? "\n" + line : line;
    if (!ctx.inCode && isTableSepLine(line) && i > 0 && lines[i - 1].includes("|")) {
      ctx.tableHeader = lines[i - 1] + "\n" + line;
    } else if (!ctx.inCode && !line.includes("|")) {
      ctx.tableHeader = null;
    }
    updateFenceState(ctx, line);
  }

  // 产出最后一块
  if (ctx.current) {
    if (ctx.inCode) ctx.current += "\n```";
    ctx.chunks.push(ctx.current);
  }

  return ctx.chunks;
}

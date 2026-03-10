#!/usr/bin/env python3
"""Generate QQBot + OpenClaw architecture diagram for product managers."""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import numpy as np

# ── 中文字体 ──
plt.rcParams['font.sans-serif'] = ['PingFang SC', 'Heiti SC', 'STHeiti', 'SimHei', 'Arial Unicode MS']
plt.rcParams['axes.unicode_minus'] = False

fig, ax = plt.subplots(1, 1, figsize=(20, 14))
ax.set_xlim(0, 20)
ax.set_ylim(0, 14)
ax.axis('off')
fig.patch.set_facecolor('#FAFBFC')

# ── 颜色 ──
C = {
    'user':    '#4A90D9',
    'qq':      '#12B7F5',
    'plugin':  '#FF6B35',
    'openclaw':'#6C5CE7',
    'ai':      '#00B894',
    'skill':   '#FDCB6E',
    'white':   '#FFFFFF',
    'text':    '#2D3436',
    'light':   '#F0F0F5',
    'border':  '#DFE6E9',
}

def rounded_box(x, y, w, h, color, label, sublabel=None, fontsize=13, icon=None, alpha=0.95):
    box = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.15",
                         facecolor=color, edgecolor='white', linewidth=2, alpha=alpha, zorder=2)
    ax.add_patch(box)
    cy = y + h/2
    if sublabel:
        cy += 0.15
    txt = f"{icon} {label}" if icon else label
    ax.text(x + w/2, cy, txt, ha='center', va='center', fontsize=fontsize,
            fontweight='bold', color='white' if color not in [C['white'], C['light'], C['skill']] else C['text'], zorder=3)
    if sublabel:
        ax.text(x + w/2, cy - 0.35, sublabel, ha='center', va='center', fontsize=9,
                color='#ffffffbb' if color not in [C['white'], C['light'], C['skill']] else '#636e72', zorder=3)

def section_box(x, y, w, h, color, label, fontsize=11):
    box = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.1",
                         facecolor=color + '15', edgecolor=color, linewidth=1.5, linestyle='--', zorder=1)
    ax.add_patch(box)
    ax.text(x + 0.15, y + h - 0.25, label, ha='left', va='center', fontsize=fontsize,
            fontweight='bold', color=color, zorder=3)

def arrow(x1, y1, x2, y2, color='#636e72', style='->', label=None, lw=2):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw, connectionstyle="arc3,rad=0"),
                zorder=4)
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx, my + 0.2, label, ha='center', va='center', fontsize=8, color=color,
                bbox=dict(boxstyle='round,pad=0.2', facecolor='white', edgecolor='none', alpha=0.9), zorder=5)

def double_arrow(x1, y1, x2, y2, color='#636e72', label=None, lw=2):
    arrow(x1, y1, x2, y2, color=color, style='<->', label=label, lw=lw)

# ══════════════════════════════════════════════
# 标题
# ══════════════════════════════════════════════
ax.text(10, 13.5, 'OpenClaw QQBot 插件 · 系统架构', ha='center', va='center',
        fontsize=22, fontweight='bold', color=C['text'])
ax.text(10, 13.1, '让 AI 助手通过 QQ 与用户对话', ha='center', va='center',
        fontsize=12, color='#636e72')

# ══════════════════════════════════════════════
# 第一层：用户侧
# ══════════════════════════════════════════════
rounded_box(1, 11.2, 2.5, 1.2, C['user'], '👤 QQ 用户', '私聊 / 群聊 / 频道', fontsize=14)
rounded_box(5, 11.2, 2.5, 1.2, C['user'], '👥 QQ 群', '@ 机器人触发', fontsize=14)
rounded_box(9, 11.2, 2.5, 1.2, C['user'], '📢 QQ 频道', '公域/私域频道', fontsize=14)

# ══════════════════════════════════════════════
# 第二层：QQ 平台
# ══════════════════════════════════════════════
section_box(0.5, 9, 12, 1.8, C['qq'], '')
rounded_box(3, 9.3, 6, 1.2, C['qq'], '🐧 QQ 机器人平台', 'WebSocket 长连接 + HTTP API', fontsize=15)

# 用户 → QQ 平台
arrow(2.25, 11.2, 4.5, 10.5, C['qq'], label='发消息')
arrow(6.25, 11.2, 6, 10.5, C['qq'])
arrow(10.25, 11.2, 7.5, 10.5, C['qq'])

# ══════════════════════════════════════════════
# 第三层：QQBot 插件（核心）
# ══════════════════════════════════════════════
section_box(0.5, 5.2, 18.5, 3.5, C['plugin'], 'QQBot 渠道插件 (@tencent-connect/openclaw-qqbot)')

# 左侧：网关
rounded_box(1, 6.8, 3, 1.2, C['plugin'], '🔌 WebSocket 网关', '连接/心跳/重连/Resume', fontsize=11)
# 中间：消息处理
rounded_box(4.5, 6.8, 3.5, 1.2, C['plugin'], '📨 消息处理引擎', '收发/分块/限流/队列', fontsize=11)
# 右侧：富媒体
rounded_box(8.5, 6.8, 3, 1.2, C['plugin'], '🎨 富媒体处理', '图片/语音/视频/文件', fontsize=11)

# 下排
rounded_box(1, 5.5, 2.5, 1, '#E17055', '🔑 多账户管理', '独立Token/连接', fontsize=9)
rounded_box(3.8, 5.5, 2.5, 1, '#E17055', '📢 主动消息', '推送/广播/定时', fontsize=9)
rounded_box(6.6, 5.5, 2.5, 1, '#E17055', '🎙️ 语音处理', 'STT转文字/TTS合成', fontsize=9)
rounded_box(9.4, 5.5, 2.5, 1, '#E17055', '🖼️ 本地图床', '自动上传/去重缓存', fontsize=9)

# 右侧能力标签
rounded_box(12.2, 7.5, 6.3, 1, C['skill'], '⭐ 核心能力', fontsize=12)
capabilities = [
    '✅ 私聊 / 群聊 / 频道 三场景',
    '✅ 图片·语音·视频·文件 收发',
    '✅ 语音转文字 (STT) + 文字转语音 (TTS)',
    '✅ 多机器人同时在线',
    '✅ 定时提醒 & 主动推送',
    '✅ 断线自动重连 & Session 恢复',
    '✅ 30+ 标签变体自动纠错',
    '✅ 跨平台 Mac/Linux/Windows',
]
for i, cap in enumerate(capabilities):
    ax.text(12.4, 7.2 - i * 0.28, cap, ha='left', va='center', fontsize=8.5,
            color=C['text'], zorder=3)

# QQ平台 → 插件
double_arrow(6, 9.3, 6, 8.0, C['qq'], label='WebSocket', lw=2.5)

# ══════════════════════════════════════════════
# 第四层：OpenClaw 框架
# ══════════════════════════════════════════════
section_box(0.5, 1.5, 12, 3.4, C['openclaw'], 'OpenClaw AI 助手框架')

rounded_box(1, 3.2, 2.8, 1.2, C['openclaw'], '🧠 对话管理', '上下文/多轮/记忆', fontsize=11)
rounded_box(4.2, 3.2, 2.8, 1.2, C['openclaw'], '🔧 工具系统', 'Function Calling', fontsize=11)
rounded_box(7.4, 3.2, 2.8, 1.2, C['openclaw'], '⏰ 定时任务', 'Cron 调度器', fontsize=11)

rounded_box(1, 1.8, 3.5, 1.1, C['openclaw'], '📚 Skills 技能', 'qqbot-media / qqbot-cron', fontsize=10)
rounded_box(5, 1.8, 3, 1.1, C['openclaw'], '🔌 插件系统', '渠道/工具插件', fontsize=10)
rounded_box(8.5, 1.8, 3.5, 1.1, C['openclaw'], '⚙️ 配置管理', 'openclaw.json', fontsize=10)

# 插件 → OpenClaw
double_arrow(4, 5.5, 4, 4.4, C['openclaw'], label='消息桥接', lw=2.5)

# ══════════════════════════════════════════════
# 右侧：AI 模型层
# ══════════════════════════════════════════════
section_box(13, 1.5, 6, 3.4, C['ai'], 'AI 模型层（可替换）')

rounded_box(13.5, 3.5, 5, 0.85, C['ai'], '🤖 Claude / GPT / DeepSeek / 混元 ...', fontsize=10)
rounded_box(13.5, 2.5, 2.3, 0.8, '#00A884', '💬 对话', fontsize=10)
rounded_box(16.2, 2.5, 2.3, 0.8, '#00A884', '🎨 画图', fontsize=10)
rounded_box(13.5, 1.7, 2.3, 0.65, '#00A884', '🔍 搜索', fontsize=9)
rounded_box(16.2, 1.7, 2.3, 0.65, '#00A884', '📝 写作', fontsize=9)

# OpenClaw → AI
double_arrow(10.3, 3.2, 13.5, 3.2, C['ai'], label='API 调用', lw=2.5)

# ══════════════════════════════════════════════
# 流程标注
# ══════════════════════════════════════════════
ax.text(10, 0.7, '💡 用户在 QQ 发消息 → QQBot 插件接收 → 交给 OpenClaw → AI 模型回复 → 通过 QQ 返回给用户',
        ha='center', va='center', fontsize=11, color='#636e72', style='italic',
        bbox=dict(boxstyle='round,pad=0.5', facecolor='#f8f9fa', edgecolor=C['border'], linewidth=1))

ax.text(10, 0.2, 'v1.5.5 · @tencent-connect/openclaw-qqbot · MIT License',
        ha='center', va='center', fontsize=9, color='#b2bec3')

plt.tight_layout(pad=0.5)
plt.savefig('/Users/lishoushuai/tmp/qqbot/docs/images/architecture.png', dpi=200, bbox_inches='tight',
            facecolor='#FAFBFC', edgecolor='none')
print("Architecture diagram saved to docs/images/architecture.png")

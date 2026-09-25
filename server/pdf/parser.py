#!/usr/bin/env python3
"""
MethodPilot PDF Parser —— PyMuPDF 实现

为什么必须是"带页码"的解析：
Evidence-First 的整条链建立在 (paper_id, section, page, content) 之上。
如果解析只吐一整段纯文本，Evidence 就永远无法回指到"第几页第几节"，
产品的核心承诺会直接失效。所以本解析器的第一设计目标不是"把字读出来"，
而是"把每个字读出来时还知道它在第几页、属于哪一节"。

处理流程：
    逐页取词块
      ↓ 版面聚类 → 恢复行 / 段
      ↓ 页眉页脚检测（跨页重复 + 位置接近页边）
      ↓ 双栏阅读顺序恢复（按栏切分，栏内自上而下）
      ↓ 章节标题识别（编号 / 常见标题 / 字体）
      ↓ 组装 PaperSection（含页码区间与所属页）

输出契约见 emit()。任何解析失败都返回 status="failed"，绝不抛异常导致 500。

自测：  python3 parser.py --selftest
单跑：  python3 parser.py <file.pdf> [--max-pages N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from typing import Any

try:
    import fitz  # PyMuPDF
except ImportError:  # pragma: no cover
    print(
        json.dumps(
            {
                "status": "failed",
                "error": "PyMuPDF (fitz) is not installed. Run: pip3 install PyMuPDF",
                "error_code": "PARSER_UNAVAILABLE",
            },
            ensure_ascii=False,
        )
    )
    sys.exit(0)

# --------------------------------------------------------------------------
# 常量与阈值（集中在此，便于调参而不动逻辑）
# --------------------------------------------------------------------------

# 正文最小可接受字符数；低于此值说明是扫描件或解析失败
MIN_TEXT_CHARS = 120

# 页眉页脚判定：位置在页面上下 X% 之内，且跨页重复出现
HEADER_ZONE = 0.085
FOOTER_ZONE = 0.915
REPEAT_RATIO = 0.5

# 一行内两段之间超过该比例页面宽度即视为不同栏
COLUMN_GAP_RATIO = 0.055

# 章节标题的编号模式
NUMBERED_HEADING = re.compile(
    r"^\s*(?:(?P<num>\d{1,2}(?:\.\d{1,2}){0,3})"
    r"(?:\.)?\s+)(?P<title>[A-Z][^.]{1,80})$"
)

# 无编号但常见的固定标题
FIXED_HEADINGS = {
    "abstract",
    "introduction",
    "related work",
    "background",
    "preliminaries",
    "method",
    "methods",
    "methodology",
    "approach",
    "proposed method",
    "proposed approach",
    "model",
    "system design",
    "experiments",
    "experimental setup",
    "experiment",
    "evaluation",
    "results",
    "results and discussion",
    "discussion",
    "analysis",
    "ablation study",
    "ablation studies",
    "limitations",
    "conclusion",
    "conclusions",
    "conclusion and future work",
    "future work",
    "references",
    "acknowledgments",
    "acknowledgements",
    "appendix",
}

# 明确不作为章节标题的固定词组（避免把 "In this paper we..." 误判）
HEADING_STOPWORDS = {
    "in",
    "we",
    "the",
    "this",
    "our",
    "these",
    "however",
    "therefore",
    "although",
    "since",
    "as",
    "for",
    "to",
    "by",
    "with",
    "figure",
    "table",
    "fig",
    "eq",
    "equation",
    "algorithm",
}

# 版本 / 预印本声明等页眉，虽然跨页重复度可能不够，但绝不该当正文
RUNNING_HEAD_HINTS = [
    re.compile(r"^published as a conference paper", re.I),
    re.compile(r"^accepted (at|to) ", re.I),
    re.compile(r"^submitted to ", re.I),
    re.compile(r"^workshop on ", re.I),
]

# 图表数据行的特征：以数字开头且含较多数字/箭头/单位
FIGURE_ROW = re.compile(r"^[\d.\s%→\-±]+$|^(?:\d+(?:\.\d+)?\s+){2,}")
HAS_ARROW = re.compile(r"[→←↑↓⇢⇠]")
MANY_DIGITS = re.compile(r"(?:\d[^\w]*){4,}")

# 以数字开头的行（"22 BUTLER (best of 8)" / "0.25 Shell-only agent"）：
# 这类几乎全是图表坐标轴标签或列表编号，不是章节。
LEADING_NUMBER = re.compile(r"^\s*\d+(?:\.\d+)?\s+\S")

# 章节编号：只接受形如 "1"、"2.3"、"3.1.2"，且编号后必须跟真标题
SECTION_NUMBER = re.compile(r"^\s*(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.*)$")

# 排版噪声：PDF 字体映射错误产生的乱码（无正常英文词）
def is_garbled(text: str) -> bool:
    """判断是否为字体映射错误产生的乱码。

    PDF 里嵌入子集字体时，若 ToUnicode 表缺失，PyMuPDF 会按字体码位硬解，
    得到 "Ҽ <RX DUH LQ WKH PLGGOH" 这类串。特征是几乎没有常见英文词、
    且大量非常用符号。这类内容留着只会污染章节名。
    """
    letters = re.findall(r"[A-Za-z]", text)
    if len(letters) < 6:
        return False
    words = re.findall(r"[A-Za-z]{2,}", text)
    if not words:
        return True
    # 常见短词命中率：正常英文句子一定会命中 love/the/are/in/of 之类
    COMMON = {
        "the", "of", "in", "to", "and", "is", "are", "you", "for", "on", "at",
        "we", "it", "as", "be", "by", "or", "an", "this", "that", "with", "human",
    }
    hits = sum(1 for w in words if w.lower() in COMMON)
    weird = len(re.findall(r"[^\x00-\x7F]", text))
    return hits == 0 and len(words) >= 4 or weird > len(text) * 0.25

# --------------------------------------------------------------------------
# LaTeX 数学符号修复
# --------------------------------------------------------------------------

# LaTeX 排版的 PDF 用 Computer Modern 数学字体（CMR10 / CMSY10 / CMMI10 等）。
# 这些字形在文本层里是**独立的 span，字号比正文小约 0.1pt，字面为零宽度**，
# 于是 PyMuPDF 抽出来会得到两类污染：
#
#   1) 变音符被拆成独立字符：\hat{A} → 一个孤立的 'ˆ' 占一行，
#      真正的 'A' 在下一行。读起来是 "^ A = A，其中 A 表示动作空间"。
#   2) 数学符号与后续斜体粘连：'∪' 与 'L' 之间没有空格 → '∪L'。
#
# 这不影响 Evidence 校验（两边都按同样的文本比对），但严重影响可读性——
# 一个"读论文"的产品把公式读成这样，用户会直接怀疑解析质量。
#
# 修复原则：**只做保守的、可判定的替换**，不试图还原 LaTeX 语义。
# 拿不准的一律不动——错误的"修复"比留着原样更糟。

# 孤立变音符 → 预期它是用普通字母替代（A 是原论文的符号名，比 'ˆ' 更有信息量）
LONE_ACCENTS = {
    "\u02c6": "A",  # ˆ modifier letter circumflex  ← \hat{}
    "\u02dc": "A",  # ˜ small tilde               ← \tilde{}
    "\u02c7": "A",  # ˇ caron                     ← \check{}
    "\u00af": "A",  # ¯ macron                    ← \bar{}
    "\u02d9": "A",  # ˙ dot above                 ← \dot{}
}

# 数学符号两侧补空格。只处理明确无歧义的符号，
# 且要求它紧邻字母/数字（避免把已经是 " A ∪ L " 的正常写法再动一遍）。
MATH_SYMBOLS = "∪∩∈∅⊆⊂≥≤≠≈∀∃→←↔⇒⇔⊕⊗⊥∥⋅⋯"


def is_math_span(font: str, size: float, body_size: float) -> bool:
    """判断某个 span 是否来自 LaTeX 数学字体。

    字号比正文小 0.1pt 以上是 Computer Modern 数学字形的稳定特征
    （原论文正文 10.1pt，数学 10.0pt）。字体名同时兜底，
    因为有些 PDF 会保留 CMR/CMSY 字族名。
    """
    name = font.upper()
    if any(tag in name for tag in ("CMR", "CMSY", "CMMI", "CMEX", "MSAM", "MSBM")):
        return True
    # 数学字号偏小：比正文小一点但不到小标题的程度
    return body_size > 0 and 0.05 < (body_size - size) < 0.6


def repair_math_text(text: str) -> str:
    """修复 LaTeX 数学符号造成的文本层污染。

    只做两件事：
      a) 把孤立的变音符替换成它大概率修饰的字母，而不是留一个悬空的 'ˆ'；
      b) 给紧贴字母的数学符号补空格。
    其余一律不动。
    """
    if not text:
        return text

    out = text

    # a) 孤立变音符：前后都不是字母时，认为它是悬空的 \hat{} 之类
    for accent, letter in LONE_ACCENTS.items():
        # ' ˆ A' 或 'ˆ' 独占：把变音符换成字母 A（原论文用 A 表示动作空间）
        out = re.sub(
            r"(?<![A-Za-z])" + re.escape(accent) + r"(?![A-Za-z])",
            letter,
            out,
        )

    # b) 数学符号补空格：'∪L' → '∪ L'，'A∪' → 'A ∪'
    for ch in MATH_SYMBOLS:
        out = re.sub(r"(?<=[A-Za-z0-9])" + re.escape(ch), " " + ch, out)
        out = re.sub(re.escape(ch) + r"(?=[A-Za-z0-9])", ch + " ", out)

    # 合并连续空格并去掉行首空格（保持换行结构不变）。
    # 顺序有讲究：必须先按行处理，再做跨行的空格合并——
    # 反过来写的话 "\n  baz" 会先被压成 "\n baz"，行首就多出一个空格。
    lines = [re.sub(r"[ \t]{2,}", " ", ln).lstrip(" \t") for ln in out.split("\n")]
    out = "\n".join(lines)
    # 行尾空格也去掉（PDF 行末常有多余空白）
    out = "\n".join(ln.rstrip() for ln in out.split("\n"))

    return out


# 噪声行：版权、arXiv 水印、页码等，直接丢弃
NOISE_PATTERNS = [
    re.compile(r"^arxiv:\d{4}\.\d{4,5}", re.I),
    re.compile(r"^\s*page\s*\d+\s*(of\s*\d+)?\s*$", re.I),
    re.compile(r"^\s*\d{1,4}\s*$"),  # 纯页码
    re.compile(r"preprint\.?\s*under review", re.I),
    re.compile(r"^\s*under review as a conference paper", re.I),
    re.compile(r"^\s*\d+\s*/\s*\d+\s*$"),
    re.compile(r"proceedings of the", re.I),
    re.compile(r"^\s*©\s*\d{4}", re.I),
    re.compile(r"^\s*copyright\s+\d{4}", re.I),
    re.compile(r"^\s*all rights reserved", re.I),
    re.compile(r"^\s*https?://\S+\s*$", re.I),
    re.compile(r"^\s*doi:\s*10\.", re.I),
]


# --------------------------------------------------------------------------
# 数据结构
# --------------------------------------------------------------------------


@dataclass
class Block:
    """一个段落块。保留页码与版面坐标，是所有后续判断的基础。"""

    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    size: float = 0.0
    bold: bool = False
    page_width: float = 0.0
    page_height: float = 0.0

    @property
    def y_norm(self) -> float:
        return self.y0 / self.page_height if self.page_height else 0.0

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return max(self.y1 - self.y0, 0.1)

    @property
    def x_center_norm(self) -> float:
        return ((self.x0 + self.x1) / 2) / self.page_width if self.page_width else 0.5


@dataclass
class Line:
    """原始行。整页排版的 PDF（常见于 LaTeX 源编译的论文）
    会把整页塞进一个 block，所以必须先拆到行级再重组段落。"""

    page: int
    x0: float
    y0: float
    x1: float
    y1: float
    text: str
    size: float
    bold: bool
    page_width: float
    page_height: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return max(self.y1 - self.y0, 0.1)

    @property
    def y_norm(self) -> float:
        return self.y0 / self.page_height if self.page_height else 0.0

    @property
    def x_center_norm(self) -> float:
        return ((self.x0 + self.x1) / 2) / self.page_width if self.page_width else 0.5


@dataclass
class Section:
    name: str
    page: int
    content: str
    summary: str = ""
    pages: list[int] = field(default_factory=list)


# --------------------------------------------------------------------------
# 1. 逐页取块
# --------------------------------------------------------------------------


def extract_lines(doc: "fitz.Document", max_pages: int | None = None) -> tuple[list[Line], int]:
    """把 PDF 拆成带页码与坐标的**行**。

    之所以落到行级而不是 block 级：LaTeX 编译出的论文常把整页文本放进一个 block，
    直接按 block 处理会把"标题 + 摘要 + 正文"糊成一段，章节识别必然失败。
    拿到行及其坐标后，才能用行宽判断"上一行是否另起一段"。
    """
    lines: list[Line] = []
    n_pages = doc.page_count if max_pages is None else min(doc.page_count, max_pages)

    for pno in range(n_pages):
        page = doc[pno]
        pw, ph = page.rect.width, page.rect.height
        raw = page.get_text("dict")

        for blk in raw.get("blocks", []):
            if blk.get("type") != 0:  # 0 = 文本，1 = 图片
                continue
            for line in blk.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(s.get("text", "") for s in spans)
                if not text.strip():
                    continue
                sizes = [s.get("size", 0.0) for s in spans if s.get("text", "").strip()]
                flags = [bool(s.get("flags", 0) & 2**4) for s in spans]
                lx0, ly0, lx1, ly1 = line["bbox"]

                # 本行正文基准字号（取最大的那个 span，通常是正文字体）
                body = max(sizes) if sizes else 0.0
                # 只要该行含数学字体 span，就整行跑一次保守修复。
                # 逐 span 替换会把 span 边界打乱，反而影响后面的宽度判断。
                if any(
                    is_math_span(s.get("font", ""), s.get("size", 0.0), body)
                    for s in spans
                    if s.get("text", "").strip()
                ):
                    text = repair_math_text(text)

                lines.append(
                    Line(
                        page=pno + 1,  # 对外 1-based
                        x0=lx0,
                        y0=ly0,
                        x1=lx1,
                        y1=ly1,
                        text=text,
                        size=body,
                        bold=any(flags),
                        page_width=pw,
                        page_height=ph,
                    )
                )

    return lines, n_pages


def line_height(lines: list[Line]) -> float:
    """正文行高（中位数）。用中位数而非均值，避免被公式块拉偏。"""
    hs = sorted(l.height for l in lines if len(l.text.strip()) > 2)
    if not hs:
        return 11.0
    return hs[len(hs) // 2]


def merge_lines_into_blocks(lines: list[Line], lh: float) -> list[Block]:
    """把行重组成段落块。

    换段判据有两条，满足其一即另起一段：
      1. 上一行**明显没写满**（右端离版心右界差出 2 个字宽以上）
         —— 这是最可靠的段落结束信号，与固定行距无关；
      2. 两行垂直间距异常大（超过 0.8 倍行高）—— 兼顾手排/空行分隔的 PDF。

    同时把英文换行连字符接回来："distri-" + "buted" → "distributed"。
    """
    if not lines:
        return []

    # 用同一行数重新走一遍分块，但这次加上"行本身像标题就必须独立成块"的判据。
    # 为什么需要第三条：当标题与正文用同一字号时（很多会议模板都这样），
    # 仅靠"下一行变小"是判不出来的，必须在标题行自己身上识别。
    blocks: list[Block] = []
    groups: list[list[Line]] = []
    cur: list[Line] = [lines[0]]

    for prev, nxt in zip(lines, lines[1:]):
        same_page = nxt.page == prev.page
        v_gap = nxt.y0 - prev.y1
        right_ref = max(prev.x1, nxt.x1)
        prev_short = (right_ref - prev.x1) > prev.size * 1.6

        nxt_is_heading = looks_like_heading_text(nxt.text) and nxt.width < (nxt.page_width * 0.6)

        broke = (
            prev_short
            or v_gap > lh * 0.8
            or not same_page
            or (nxt.size > prev.size + 0.6)
            or nxt_is_heading
        )

        if broke:
            groups.append(cur)
            cur = [nxt]
        else:
            cur.append(nxt)
    groups.append(cur)

    for g in groups:
        text = ""
        for i, ln in enumerate(g):
            piece = ln.text.strip()
            if i > 0 and text.endswith("-") and piece[:1].islower():
                text = text[:-1] + piece  # 接回被拆开的英文单词
            else:
                text = f"{text} {piece}" if text else piece
        text = re.sub(r"\s{2,}", " ", text).strip()
        if not text:
            continue
        blocks.append(
            Block(
                page=g[0].page,
                x0=min(x.x0 for x in g),
                y0=min(x.y0 for x in g),
                x1=max(x.x1 for x in g),
                y1=max(x.y1 for x in g),
                text=text,
                size=max(x.size for x in g),
                bold=any(x.bold for x in g),
                page_width=g[0].page_width,
                page_height=g[0].page_height,
            )
        )

    return blocks


def extract_blocks(doc: "fitz.Document", max_pages: int | None = None) -> tuple[list[Block], int]:
    lines, n_pages = extract_lines(doc, max_pages)
    return merge_lines_into_blocks(lines, line_height(lines)), n_pages


# --------------------------------------------------------------------------
# 2. 噪声与页眉页脚
# --------------------------------------------------------------------------


def strip_noise(blocks: list[Block]) -> list[Block]:
    out = []
    for b in blocks:
        if any(p.search(b.text) for p in NOISE_PATTERNS):
            continue
        if any(p.search(b.text.strip()) for p in RUNNING_HEAD_HINTS):
            continue
        # 单字符 / 无字母数字的碎块（公式残渣、装饰线）
        if len(b.text) < 3 or not re.search(r"[A-Za-z0-9]", b.text):
            continue
        out.append(b)
    return out


def drop_running_heads(blocks: list[Block], n_pages: int) -> tuple[list[Block], list[str]]:
    """去掉跨页重复的页眉页脚。

    判据是"位置贴近页边" + "在多页上重复出现"，两条同时满足才丢。
    只用重复度会误伤参考文献表里重复的作者名；
    只用位置会误伤正文里恰好排在上边距的行。
    """
    if n_pages < 3:
        return blocks, []

    buckets: dict[str, set[int]] = {}
    for b in blocks:
        if b.y_norm <= HEADER_ZONE or b.y_norm >= FOOTER_ZONE:
            key = re.sub(r"\d+", "#", b.text.lower()).strip()
            if 2 < len(key) < 120:
                buckets.setdefault(key, set()).add(b.page)

    threshold = max(2, int(n_pages * REPEAT_RATIO))
    repeated = {k for k, pages in buckets.items() if len(pages) >= threshold}

    kept, removed = [], []
    for b in blocks:
        in_margin = b.y_norm <= HEADER_ZONE or b.y_norm >= FOOTER_ZONE
        key = re.sub(r"\d+", "#", b.text.lower()).strip()
        if in_margin and key in repeated:
            removed.append(b.text)
        else:
            kept.append(b)
    return kept, removed


# --------------------------------------------------------------------------
# 3. 阅读顺序（双栏 / 单栏自适应）
# --------------------------------------------------------------------------


def detect_columns(blocks: list[Block]) -> int:
    """判断这一页是几栏。返回 1 或 2。

    判据：统计每个块的"水平中心落在右半页"的比例。
      - 单栏论文：所有块都从左边距开始、宽度接近版心，中心靠近页宽中点但不会
        大量出现在右半——尤其是块的**左边界**几乎都贴着左边距。
      - 双栏论文：右栏块的左边界会稳定落在页面中部。

    用"左边界是否集中在左半"来判断，比用"中心点"稳得多：
    单栏的一个长段落，其中心也可能落在右半页，会误判成两栏。
    """
    if len(blocks) < 4:
        return 1

    pw = blocks[0].page_width or 1.0
    body = [b for b in blocks if len(b.text) > 25] or blocks

    # 版心左界 ≈ 所有块左边界的众数（贴左边距的那些块）
    left_edges = sorted(round(b.x0, 0) for b in body)
    left_margin = left_edges[len(left_edges) // 4]  # 25 分位，避开居中标题

    # 右栏块：左边界明显越过页面中线
    right_col = [b for b in body if b.x0 > pw * 0.5]
    if len(right_col) < max(2, len(body) * 0.20):
        return 1

    # 右栏块必须自己成规模且左边界一致，否则可能只是居中的表格/图注
    right_lefts = [round(b.x0, 0) for b in right_col]
    spread = max(right_lefts) - min(right_lefts)
    if spread > pw * 0.18:
        return 1

    # 而且左侧必须确实有等量的正文块
    left_col = [b for b in body if b.x0 <= pw * 0.5]
    if len(left_col) < max(2, len(body) * 0.20):
        return 1

    return 2


def order_blocks(blocks: list[Block]) -> list[Block]:
    """恢复阅读顺序。

    先按页分组、逐页判断栏数，再决定排序方式：
      - 单栏：严格按 (y0, x0) 自上而下。**绝不做任何重排**。
      - 双栏：用"通栏块"（宽度 > 65% 版心，通常是标题、跨栏图注）把页面切成
        水平带；每条带内先排通栏块，再把左栏整列排完、再排右栏。

    这里最关键的一条设计原则：**宁可退回单栏顺序，也不要冒险重排**。
    单栏论文被误判成双栏后，段落会被左右交叉拼接，章节识别必然崩掉；
    而双栏论文被当成单栏，最坏结果只是左栏和右栏交替出现——
    内容还在、页码还对，Evidence 校验依然能通过。两者代价不对称，所以判据取保守。
    """
    ordered: list[Block] = []
    pages = sorted({b.page for b in blocks})

    for pno in pages:
        pb = [b for b in blocks if b.page == pno]
        if not pb:
            continue

        if detect_columns(pb) == 1:
            ordered.extend(sorted(pb, key=lambda b: (b.y0, b.x0)))
            continue

        pw = pb[0].page_width or 1.0
        full_width = [b for b in pb if (b.x1 - b.x0) / pw > 0.65]
        rest = [b for b in pb if b not in full_width]

        # 用通栏块把页面切成水平带
        bands: list[tuple[float, float]] = []
        if full_width:
            cuts = sorted({round(b.y0, 1) for b in full_width})
            prev = -1.0
            for c in cuts:
                bands.append((prev, c))
                prev = c
            bands.append((prev, float("inf")))
        else:
            bands = [(-1.0, float("inf"))]

        for lo, hi in bands:
            band_full = sorted(
                [b for b in full_width if lo <= b.y0 < hi], key=lambda b: (b.y0, b.x0)
            )
            band_rest = [b for b in rest if lo <= b.y0 < hi]
            mid = pw / 2
            left = sorted([b for b in band_rest if b.x0 < mid], key=lambda b: (b.y0, b.x0))
            right = sorted([b for b in band_rest if b.x0 >= mid], key=lambda b: (b.y0, b.x0))
            ordered.extend(band_full)
            ordered.extend(left)
            ordered.extend(right)

    return ordered


# --------------------------------------------------------------------------
# 4. 章节识别
# --------------------------------------------------------------------------


def looks_like_heading_text(text: str) -> bool:
    """仅凭文字形态判断"像不像章节标题"，不看字号。

    与 is_heading() 分开，是因为这两件事的使用场景不同：
      - 分段阶段只有文字，用来决定要不要拆块；
      - 章节识别阶段还有字号信息，可以更准。
    两处共用同一套文字规则，避免"分段认为是标题、识别阶段又不认"的错位。
    """
    t = re.sub(r"\s+", " ", text).strip()
    if not (2 < len(t) < 100):
        return False

    # 图表数据行绝不算标题。论文里像 "60.9 CoT-SC →ReAct"、"0.79 SWE-agent"
    # 这种行既有短文本、又可能带粗体，靠字号/长度都挡不住，必须显式排除。
    if HAS_ARROW.search(t):
        return False
    if FIGURE_ROW.match(t):
        return False
    if len(MANY_DIGITS.findall(t)) >= 1 and len(t) < 40:
        return False
    # 出现多个孤立小数（图表数值）也排除
    if len(re.findall(r"\d+\.\d+", t)) >= 2:
        return False
    # 纯数值 / 数值+单位（表格单元格）
    if re.fullmatch(r"[\d.,%\s↑↓±+-]+", t):
        return False
    # 字体映射错误的乱码
    if is_garbled(t):
        return False

    words = t.split()
    if len(words) > 9:
        return False

    # 章节编号必须符合 "1" / "2.3" / "3.1.2" 形态。
    # 直接用 SECTION_NUMBER 而不是宽松的 NUMBERED_HEADING，
    # 才能挡掉 "22 BUTLER (best of 8)" 这类以数字开头的图注。
    m = SECTION_NUMBER.match(t)
    if m:
        num = m.group(1)
        title = m.group(2).strip()
        if not title or not title[0].isupper():
            return False
        if re.search(r"\d", title) and len(title.split()) <= 3:
            return False
        first = title.split()[0].lower().rstrip(":")
        if first in HEADING_STOPWORDS and len(words) > 7:
            return False
        # 编号层级超过 3 段基本是交叉引用而非章节
        if len(num.split(".")) <= 3:
            return True

    key = re.sub(r"[^a-z ]", "", t.lower()).strip()
    if key in FIXED_HEADINGS:
        return True

    # "Abstract." 这类带句点的固定标题
    key2 = re.sub(r"[^a-z ]", "", t.lower().rstrip(".")).strip()
    if key2 in FIXED_HEADINGS:
        return True

    # 附录里的原始日志/样例输出：以 "数字 + 大写缩写" 开头且含括号统计值，
    # 例如 "63 AFLChat (3 agents)(best of 3)"。这类不是章节。
    if re.match(r"^\d+\s+[A-Z][A-Za-z]*\s*\(.*\)", t):
        return False
    # 以句号结尾的完整句子（附录里的示例输出）
    if t.endswith(".") and len(words) >= 4:
        return False

    return False


def is_table_page(blocks: list[Block], pw: float) -> bool:
    """判断这一页是否以表格为主。

    表格页的块之字形分布：短块多、横向位置分散、纵向间距密集。
    这类页面上把每个单元格当段落会产出几十个"伪章节"，
    必须整页识别出来并跳过章节切分（文本仍然保留）。
    """
    if len(blocks) < 12:
        return False
    short = [b for b in blocks if len(b.text) < 30]
    if len(short) < len(blocks) * 0.5:
        return False
    # 横向起点分散：表格列各自有自己的左边界
    lefts = {round(b.x0 / 10) for b in blocks}
    return len(lefts) >= 5


def is_heading(b: Block, body_size: float, left_margin: float | None = None) -> bool:
    """综合文字形态、字号、以及横向位置判断是否章节标题。

    left_margin 这一条很必要：表格里的 "Model"、"Editor" 这类单元格
    文字形态与短标题一模一样，唯一区别是它们不贴版心左界。

    容差刻意放到 6% 页宽：双栏论文的右栏标题会相对"全页左界"偏移一整栏，
    所以调用方应先按栏算各自的左界；这里只做兜底。
    """
    if left_margin is not None and (b.x0 - left_margin) > b.page_width * 0.06:
        return False

    text = b.text.strip()

    # 只写了编号、标题被排版拆成下一块的（"3.1" / "SETUP"），
    # 单独一个编号不算标题，交给调用方与下一块合并处理。
    if re.fullmatch(r"\d{1,2}(?:\.\d{1,2}){0,3}\.?", text):
        return False

    if looks_like_heading_text(text):
        return True

    if not (2 < len(text) < 100):
        return False
    if text.endswith((".", ",", ";", ":")) and len(text.split()) > 6:
        return False
    if is_garbled(text):
        return False

    # 字号明显大于正文 + 加粗 + 词数少 → 无编号标题
    if b.bold and body_size and b.size > body_size * 1.08 and len(text.split()) <= 6:
        return True

    return False


def merge_number_blocks(blocks: list[Block]) -> list[Block]:
    """把被排版拆开的小节号与标题合并："3.1" + "SETUP" → "3.1 SETUP"。

    不少模板会把 "3.1" 和 "SETUP" 放在同一行的两个文本块里，
    PyMuPDF 会当成两块返回。不合并的话，既丢标题又会让编号误判。
    """
    out: list[Block] = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if (
            re.fullmatch(r"\d{1,2}(?:\.\d{1,2}){0,3}\.?", b.text.strip())
            and i + 1 < len(blocks)
        ):
            nxt = blocks[i + 1]
            same_line = abs(nxt.y0 - b.y0) < max(b.height, nxt.height) * 0.6
            # 编号与标题之间允许有间距，但不能隔太远（不能是另一栏）
            near = (nxt.x0 - b.x0) < b.page_width * 0.25
            if same_line and near and nxt.size <= b.size + 0.6:
                merged = Block(
                    page=b.page,
                    x0=b.x0,
                    y0=min(b.y0, nxt.y0),
                    x1=nxt.x1,
                    y1=max(b.y1, nxt.y1),
                    text=f"{b.text.strip()} {nxt.text.strip()}",
                    size=max(b.size, nxt.size),
                    bold=b.bold or nxt.bold,
                    page_width=b.page_width,
                    page_height=b.page_height,
                )
                out.append(merged)
                i += 2
                continue
        out.append(b)
        i += 1
    return out


def page_left_margins(blocks: list[Block]) -> float:
    """版心左界：取所有块左边界的 10 分位，避开缩进块与居中标题的干扰。

    注意这是"全页"左界；双栏论文的右栏标题会超出它，
    因此调用方应对双栏页分别按栏计算（见 split_sections）。
    """
    xs = sorted(b.x0 for b in blocks if len(b.text) > 30)
    if not xs:
        return 0.0
    return xs[max(0, int(len(xs) * 0.10))]


def column_left_margin(blocks: list[Block], pw: float) -> float:
    """按栏估算左界：分别取左半与右半块左边界的低分位，取更靠左的那个。

    这样双栏论文里，右栏标题相对右栏左界的偏移为 0，不会再被位置判据误杀。
    """
    left = [b.x0 for b in blocks if b.x0 < pw * 0.55 and len(b.text) > 20]
    right = [b.x0 for b in blocks if b.x0 >= pw * 0.45 and len(b.text) > 20]
    cands = []
    for xs in (left, right):
        if xs:
            xs.sort()
            cands.append(xs[max(0, int(len(xs) * 0.10))])
    if not cands:
        return 0.0
    return min(cands)


def body_font_size(blocks: list[Block]) -> float:
    """正文主字号：按字符数加权，取出现最多的字号档。"""
    weight: dict[float, int] = {}
    for b in blocks:
        # 页码/页眉已剔除，剩余多为正文；仍排除超短块避免标题污染
        if len(b.text) < 40:
            continue
        key = round(b.size, 1)
        weight[key] = weight.get(key, 0) + len(b.text)
    if not weight:
        return 0.0
    return max(weight.items(), key=lambda kv: kv[1])[0]


def split_sections(blocks: list[Block]) -> list[Section]:
    """把有序文本块切分成章节。

    刻意用「显式参数 + 显式返回值」而不是闭包改 current / nonlocal：
    闭包在这里极容易写错——`commit()` 读的是变量调用时刻的值，
    而调用方常在 commit() 之后才更新该变量，于是每节内容整体错位、
    文末最后一节直接丢失。把参数写出来，这类顺序问题就不可能发生。

    另外：表格页整体跳过章节切分。表格单元格在文字形态上与短标题无异
    （"Model"、"% Resolved"），逐块判断必然误判，只能整页排除。
    """
    body_size = body_font_size(blocks)
    sections: list[Section] = []

    # 逐页判断是否表格页，是则该页不参与章节切分
    by_page: dict[int, list[Block]] = {}
    for b in blocks:
        by_page.setdefault(b.page, []).append(b)
    table_pages = {
        p for p, bs in by_page.items() if is_table_page(bs, bs[0].page_width or 1.0)
    }

    lm = page_left_margins(blocks)
    lm_col = column_left_margin(blocks, blocks[0].page_width if blocks else 612.0)

    cur_name = "Preamble"
    cur_page = blocks[0].page if blocks else 1
    buf: list[str] = []
    page_seen: set[int] = set()

    def commit(name: str, page: int, texts: list[str], pages: set[int]) -> None:
        text = "\n\n".join(texts).strip()
        if text:
            sections.append(
                Section(name=name, page=page, content=text, pages=sorted(pages))
            )

    for b in blocks:
        if b.page in table_pages:
            buf.append(b.text)
            page_seen.add(b.page)
            continue

        # 位置判据用"按栏左界"更宽松的那个，避免双栏论文右栏标题被误杀
        margin_ok = is_heading(b, body_size, lm_col)
        if margin_ok:
            commit(cur_name, cur_page, buf, page_seen)
            buf = []
            page_seen = set()
            cur_name = normalize_heading(b.text)
            cur_page = b.page
        else:
            buf.append(b.text)
            page_seen.add(b.page)

    commit(cur_name, cur_page, buf, page_seen)  # 收尾：否则文末章节会整节丢失
    return [s for s in sections if len(s.content) >= 40]


def normalize_heading(text: str) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+", r"\1 ", t)
    if len(t) > 90:
        t = t[:87] + "…"
    return t


# --------------------------------------------------------------------------
# 5. 元信息
# --------------------------------------------------------------------------


def guess_meta(doc: "fitz.Document", blocks: list[Block], sections: list[Section]) -> dict[str, Any]:
    meta = doc.metadata or {}
    first_page = [b for b in blocks if b.page == 1]

    title = (meta.get("title") or "").strip()
    if not title or len(title) < 8:
        # 取第一页字号最大的块作为标题
        cands = sorted(first_page[:14], key=lambda b: (-b.size, b.y0))
        title = cands[0].text if cands else "Untitled"

    # 作者：优先文档元信息；否则取标题下方、篇幅较短且含逗号的行
    authors: list[str] = []
    if (meta.get("author") or "").strip():
        authors = [a.strip() for a in re.split(r"[;,]|\band\b", meta["author"]) if a.strip()]
    if not authors and first_page:
        title_block = max(first_page[:14], key=lambda b: b.size)
        for b in first_page:
            if b.y0 <= title_block.y0:
                continue
            if b is title_block:
                continue
            if 4 < len(b.text) < 140 and (" and " in b.text or b.text.count(",") >= 1):
                if re.search(r"\d{4}|@|university|institute", b.text, re.I):
                    continue
                authors = [a.strip() for a in re.split(r",|\band\b", b.text) if a.strip()]
                break
    authors = [a for a in authors if len(a) > 1][:12]

    year = 0
    ym = re.search(r"(19|20)\d{2}", str(meta.get("creationDate") or ""))
    if ym:
        year = int(ym.group(0))
    if not year:
        for b in first_page[:20]:
            ym = re.search(r"\b(19|20)\d{2}\b", b.text)
            if ym:
                year = int(ym.group(0))
                break
    if not year:
        ds = meta.get("creationDate") or ""
        ym = re.search(r"(\d{4})", str(ds))
        year = int(ym.group(1)) if ym else 0

    abstract = ""
    for s in sections:
        if re.search(r"abstract", s.name, re.I):
            abstract = s.content.strip()
            break
    if not abstract:
        joined = "\n\n".join(b.text for b in first_page)
        am = re.search(r"abstract[:\s—\-]*(.{80,2200}?)(?:\n\n|\bkeywords\b|\b1\s+introduction\b)", joined, re.I | re.S)
        if am:
            abstract = re.sub(r"\s+", " ", am.group(1)).strip()
    abstract = abstract[:2200]

    keywords: list[str] = []
    km = re.search(r"keywords?[:\s—\-]*([^\n]{5,240})", "\n".join(b.text for b in first_page), re.I)
    if km:
        keywords = [k.strip() for k in re.split(r"[,;·]", km.group(1)) if 1 < len(k.strip()) < 48][:12]

    return {
        "title": title[:300],
        "authors": authors,
        "year": year,
        "abstract": abstract,
        "keywords": keywords,
    }


def summarize(text: str, limit: int = 260) -> str:
    """章节摘要：取章节首段前若干句。

    刻意不做抽取式摘要模型——这里是"结构预览"而非"AI 结论"，
    不应冒充 AI 输出。真正的章节理解交给下游 LLM。
    """
    flat = re.sub(r"\s+", " ", text).strip()
    if not flat:
        return ""
    sents = re.split(r"(?<=[.!?])\s+", flat)
    out, size = [], 0
    for s in sents:
        if size + len(s) > limit and out:
            break
        out.append(s)
        size += len(s)
    s = " ".join(out).strip()
    return (s[: limit - 1] + "…") if len(s) > limit else s


# --------------------------------------------------------------------------
# 6. 入口
# --------------------------------------------------------------------------


def parse(path: str, max_pages: int | None = None) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"status": "failed", "error": f"File not found: {path}", "error_code": "FILE_NOT_FOUND"}
    if os.path.getsize(path) == 0:
        return {"status": "failed", "error": "PDF is empty (0 bytes)", "error_code": "EMPTY_FILE"}

    with open(path, "rb") as fh:
        head = fh.read(5)
    if head[:5] != b"%PDF-":
        return {
            "status": "failed",
            "error": "Not a PDF file (missing %PDF- signature)",
            "error_code": "NOT_A_PDF",
        }

    try:
        doc = fitz.open(path)
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed", "error": f"Cannot open PDF: {exc}", "error_code": "CORRUPT_PDF"}

    try:
        if doc.is_encrypted and not doc.authenticate(""):
            doc.close()
            return {
                "status": "failed",
                "error": "PDF is password protected",
                "error_code": "ENCRYPTED",
            }

        with open(path, "rb") as fh:
            file_hash = hashlib.sha256(fh.read()).hexdigest()

        raw_blocks, n_pages = extract_blocks(doc, max_pages)
        if not raw_blocks:
            doc.close()
            return {
                "status": "failed",
                "error": "No extractable text found; the PDF is likely a scanned image and needs OCR",
                "error_code": "NO_TEXT_LAYER",
            }

        blocks = strip_noise(raw_blocks)
        blocks, removed_heads = drop_running_heads(blocks, n_pages)
        ordered = order_blocks(blocks)
        ordered = merge_number_blocks(ordered)

        total_chars = sum(len(b.text) for b in ordered)
        if total_chars < MIN_TEXT_CHARS:
            doc.close()
            return {
                "status": "failed",
                "error": f"Extracted only {total_chars} characters; the PDF is likely a scanned image",
                "error_code": "NO_TEXT_LAYER",
            }

        sections = split_sections(ordered)
        meta = guess_meta(doc, ordered, sections)
        page_count = doc.page_count
        doc.close()

        payload_sections = [
            {
                "name": s.name,
                "page": s.page,
                "pages": s.pages,
                "content": s.content,
                "summary": summarize(s.content),
            }
            for s in sections
        ]

        # 逐页文本：Evidence Validator 需要用它验证 quote 是否真的出现在某一页
        pages: dict[str, str] = {}
        for b in ordered:
            pages.setdefault(str(b.page), "")
            pages[str(b.page)] += b.text + "\n"
        pages = {k: v.strip() for k, v in pages.items()}

        return {
            "status": "ok",
            "file_hash": file_hash,
            "page_count": page_count,
            "parsed_pages": n_pages,
            "char_count": total_chars,
            "title": meta["title"],
            "authors": meta["authors"],
            "year": meta["year"],
            "abstract": meta["abstract"],
            "keywords": meta["keywords"],
            "sections": payload_sections,
            "pages": pages,
            "removed_running_heads": removed_heads[:20],
            "warnings": (
                [f"仅解析前 {n_pages} 页（共 {page_count} 页）"] if n_pages < page_count else []
            ),
        }
    except Exception as exc:  # noqa: BLE001
        try:
            doc.close()
        except Exception:  # noqa: BLE001
            pass
        return {"status": "failed", "error": f"Parser error: {exc}", "error_code": "PARSE_ERROR"}


# --------------------------------------------------------------------------
# 自测：合成 PDF，不依赖任何外部样例
# --------------------------------------------------------------------------


def selftest() -> int:
    import tempfile

    cases: list[tuple[str, str]] = []

    def make_pdf(pages_text: list[str], path: str) -> None:
        d = fitz.open()
        for txt in pages_text:
            pg = d.new_page(width=595, height=842)
            pg.insert_textbox(fitz.Rect(64, 70, 531, 780), txt, fontsize=10, fontname="helv")
        d.save(path)
        d.close()

    tmp = tempfile.mkdtemp(prefix="mpparse-")

    # 1. 正常论文
    normal = os.path.join(tmp, "normal.pdf")
    body = "\n".join(
        [
            "A Study of Repository-Level Agents",
            "Alice Zhang, Bob Li",
            "Abstract. We present RepoAgent, a repository-level system that "
            "interleaves reasoning with action. It maintains persistent memory "
            "across attempts and retrieves relevant files before editing.",
            "1 Introduction",
            "Large language models have recently been applied to software "
            "engineering tasks. In this paper we study how an agent should "
            "plan and act inside a real repository with many files.",
            "2 Method",
            "Our method consists of a retriever, a planner and an executor. "
            "The planner decomposes the issue into steps and the executor "
            "applies edits to the working tree.",
            "3 Experiments",
            "We evaluate on SWE-bench and report resolved rate. Our approach "
            "improves the baseline by a clear margin across all settings.",
        ]
    )
    make_pdf([body], normal)

    # 2. 扫描件：无文本层
    blank = os.path.join(tmp, "blank.pdf")
    d = fitz.open()
    d.new_page(width=595, height=842)
    d.save(blank)
    d.close()

    # 3. 非 PDF
    notpdf = os.path.join(tmp, "notpdf.pdf")
    with open(notpdf, "wb") as fh:
        fh.write(b"this is definitely not a pdf file")

    # 4. 空文件
    empty = os.path.join(tmp, "empty.pdf")
    open(empty, "wb").close()

    checks: list[tuple[str, bool, str]] = []

    r = parse(normal)
    checks.append(("正常论文 status=ok", r.get("status") == "ok", str(r.get("error", ""))))
    if r.get("status") == "ok":
        names = [s["name"] for s in r["sections"]]
        checks.append(("识别出 Introduction", any("Introduction" in n for n in names), str(names)))
        checks.append(("识别出 Method", any("Method" in n for n in names), str(names)))
        checks.append(("识别出 Experiments", any("Experiment" in n for n in names), str(names)))
        checks.append(("保留页码", all(isinstance(s["page"], int) and s["page"] >= 1 for s in r["sections"]), ""))
        checks.append(("逐页文本非空", bool(r["pages"]), ""))
        checks.append(("标题被识别", "Repository" in r["title"] or "RepoAgent" in str(names), r["title"]))
        checks.append(("file_hash 为 sha256", len(r["file_hash"]) == 64, ""))

    cases.append(("normal", r.get("status", "?")))

    r2 = parse(blank)
    checks.append(
        ("空白页 → NO_TEXT_LAYER", r2.get("error_code") == "NO_TEXT_LAYER", str(r2))
    )
    cases.append(("blank", r2.get("error_code", "?")))

    r3 = parse(notpdf)
    checks.append(("非 PDF → NOT_A_PDF", r3.get("error_code") == "NOT_A_PDF", str(r3)))
    cases.append(("notpdf", r3.get("error_code", "?")))

    r4 = parse(empty)
    checks.append(("空文件 → EMPTY_FILE", r4.get("error_code") == "EMPTY_FILE", str(r4)))
    cases.append(("empty", r4.get("error_code", "?")))

    r5 = parse(os.path.join(tmp, "does-not-exist.pdf"))
    checks.append(("不存在 → FILE_NOT_FOUND", r5.get("error_code") == "FILE_NOT_FOUND", str(r5)))
    cases.append(("missing", r5.get("error_code", "?")))

    # ---- LaTeX 数学符号修复（纯函数，不走 PDF） ----
    # 这些用例直接对应本轮在真实 arXiv 论文（ReAct, 2210.03629）第 3 页
    # 观测到的污染形态，不是凭空构造的。
    math_cases = [
        (
            "悬空 \\hat{} 变成孤立变音符",
            "action space to \u02c6\nA = A \u222aL, where L is the",
            "action space to A\nA = A \u222a L, where L is the",
        ),
        (
            "数学符号与字母粘连时补空格",
            "A = A \u222aL",
            "A = A \u222a L",
        ),
        (
            "符号左侧紧贴字母时补空格",
            "x\u2208S",
            "x \u2208 S",
        ),
        (
            "正常写法不被改动（幂等）",
            "A = A \u222a L, where L is",
            "A = A \u222a L, where L is",
        ),
        (
            "普通英文句子完全不受影响",
            "We propose a method that works well.",
            "We propose a method that works well.",
        ),
        (
            "连续空格被合并，换行结构保留",
            "foo   bar\n  baz",
            "foo bar\nbaz",
        ),
    ]
    for label, src, want in math_cases:
        got = repair_math_text(src)
        checks.append((f"数学修复：{label}", got == want, f"got={got!r} want={want!r}"))

    # 幂等性：跑两遍结果必须一致，否则重复解析同一页面会漂移
    once = repair_math_text("A = A \u222aL and x\u2208S")
    twice = repair_math_text(once)
    checks.append(("数学修复：幂等（跑两遍不变）", once == twice, f"{once!r} vs {twice!r}"))

    # 数学字体识别
    checks.append(
        ("数学字体识别：CMR10 且字号偏小", is_math_span("CMR10", 10.0, 10.1), "")
    )
    checks.append(
        ("数学字体识别：CMSY10 且字号偏小", is_math_span("CMSY10", 10.0, 10.1), "")
    )
    checks.append(
        ("数学字体识别：普通正文不算数学", not is_math_span("NimbusRomNo9L-Regu", 10.1, 10.1), "")
    )
    checks.append(
        ("数学字体识别：同名大字不是数学（小标题）", not is_math_span("NimbusRomNo9L-Regu", 14.0, 10.1), "")
    )

    ok = all(c[1] for c in checks)
    print("— PDF Parser 自测 —")
    for label, passed, detail in checks:
        print(f"  {'✓' if passed else '✗'} {label}" + (f"   → {detail}" if not passed and detail else ""))
    print()
    print("合成样例结果:", ", ".join(f"{k}={v}" for k, v in cases))
    print()
    print("✓ 全部通过" if ok else "✗ 存在失败项")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="MethodPilot PDF Parser")
    ap.add_argument("pdf", nargs="?", help="path to a PDF file")
    ap.add_argument("--max-pages", type=int, default=None)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not args.pdf:
        ap.print_help()
        return 2

    print(json.dumps(parse(args.pdf, args.max_pages), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

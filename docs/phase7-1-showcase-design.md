# Phase 7-1：离线 Showcase 数据方案（设计稿 · 未实施）

> 状态：**设计 + 只读验证完成，未修改任何生产代码**
> 目标：在**没有 API Key** 的前提下，让比赛 Demo 展示完整链路；
> 所有论文 / Evidence / 引用句**必须来自现有真实 PDF**，禁止伪造证据。

---

## 一、结论先行

**方案可行，且不需要改算法。** 关键验证结果（全部用真实函数跑过）：

| 验证项 | 方法 | 结果 |
|---|---|---|
| 因果句过得了三道门 | 用真实 `mentionsMethod` + 门A 句式 | ✅ AutoGen p25 → `improves` |
| 引用句过得了 validator | 用真实 `quoteMatchesPage` 比对 PDF 原文 | ✅ **5/5 全部 `form=strict`** |
| 局限句过得了 Gap 门槛 | 比对 `GAP_PATTERNS` | ✅ SWE-agent p1 命中 `open_problem` |
| 分类能被服务端接受 | 比对 `analysis.ts` 四条校验 | ✅ F1/F2/F4 + 真实 evidence |
| 下游是否按来源过滤 | 检索 `source_type` | ✅ **下游不按来源过滤**，Showcase 数据可走真实算法 |

> ⚠️ 验证中**真实拦下 1 条错误 quote**（E004 首版按记忆写成"…software engineering tasks."，
> 实际原文为"…challenging real-world software engineering problems…"）。
> 这证明「预置数据也必须过 validator」这条纪律是有效的、不是形式主义。

---

## 二、字段来源划分（核心交付物）

这是本方案最重要的划分。**必须严格区分"可确定性 mock"与"必须来自 PDF"**。

### 🟢 可由 Demo 确定性提供（结构化判定，非原文）

| 字段 | 取值 | 为什么可以 mock |
|---|---|---|
| `family_id` | `F2` / `F4` / `F1` | 这是**语义归类结论**。真实 LLM 也是"判断"，不是"抄写"。用真实摘要文本作依据即可，不涉及伪造引用 |
| `classification.reason` | 一句话判据 | 同上，是解释而非引用 |
| `classification.confidence` | `0.7` 左右 | 主观置信度，本就不来自原文 |
| `method.name` | `ReAct` / `AutoGen` / `SWE-agent` | 来自论文标题，且**解析器已真实提取到** |
| `method.name_zh` | 中文名 | 译文，非引用 |
| `task` / `paradigm` | 简短标签 | 归类字段 |
| `supports` 标签 | `['局限']` 等 | **判定标签**，不是原文内容（见下方说明） |

### 🔴 必须来自 PDF 原文（禁止编造）

| 字段 | 要求 | 来源 |
|---|---|---|
| `evidence.content`（quote） | **逐字**来自指定页，过 `quoteMatchesPage` | PDF 原文 |
| `evidence.page` | 必须与 quote 真实所在页一致 | PDF 页号 |
| `evidence.section` | 该页所属章节 | PDF 大纲 |
| `paper.title` / `page_count` | 解析器提取 | PDF |
| `method.paper_ids` / `evidence_ids` | 真实归属关系 | 上一步产物 |

### ⚠️ 关于 `supports` 的重要澄清（纠正一个常见误解）

**`supports` 不是 Gap 的硬门槛。** 读 `researchGaps.ts:706,745-750` 确认：

- Gap 的**唯一硬门槛**是 `detectGapSignals(ev)` 匹配**证据正文的句式**
- `supports` 只贡献 `+0.1` 置信度与一条 basis 记录

所以 Showcase 中给证据打 `['局限']` 标签**不是必需的** —— 只要 quote 本身含局限句式即可。
（打上更真实，因为它反映"抽取时确实认为这是局限"，且能提高置信度。）

---

## 三、Fixture 设计表

### 3.1 项目与论文

| 项 | 值 | 说明 |
|---|---|---|
| 项目名 | `Demo · 智能体方法演进` | — |
| 论文 | P001 ReAct / P002 AutoGen / P003 SWE-agent | 三篇真实 arXiv PDF |

### 3.2 方法与分类（目标：3 个真实可解释 family）

| 方法 | name | family_id | 判据依据（摘要原文，非引用句） | 支撑证据 |
|---|---|---|---|---|
| M001 (P001) | `ReAct` | **F2** 工具调用智能体 | "combine reasoning and acting with language models"、augment action space | E001 |
| M002 (P002) | `AutoGen` | **F4** 多智能体协作 | "a generalized multi-agent conversation framework" | E002 |
| M003 (P003) | `SWE-agent` | **F1** 软件工程智能体 | "LM agents to autonomously … software engineering" | E005 |

> 三族**互不相同**，可同时展示 3 个族的分布 —— 比当前"全部未分类"强得多。

### 3.3 Evidence（5 条精选，**全部已用真实 validator 验真**）

| id | paper | page | quote（完整原文） | 用途 | 已验 |
|---|---|---|---|---|---|
| E001 | P001 | 2 | `In this work, we present ReAct, a general paradigm to combine reasoning and acting with language models for solving diverse language reasoning and decision making tasks (Figure 1).` | 方法核心思想 + F2 依据 | ✅ strict |
| E002 | P002 | 2 | `While there is contemporaneous exploration of multi-agent approaches,3 we present AutoGen, a generalized multi-agent conversation framework (Figure 1), based on the following new concepts.` | 方法核心思想 + F4 依据 | ✅ strict |
| E003 | P002 | **25** | `design matches the performance of ReAct, while the three-agent design significantly outperforms ReAct.` | **因果演进（improves）** | ✅ strict |
| E004 | P003 | 2 | `From this effort, we introduce SWE-agent, an agent composed of an LM and ACI, that can interact with a computer to solve challenging real-world software engineering problems, such as those proposed in SWE-bench [20].` | 方法核心思想 + F1 依据 | ✅ strict |
| E005 | P003 | 1 | `However, applying agents to more complex code tasks like software engineering remains unexplored.` | **stated Gap** + F1 依据 | ✅ strict |

> ⚠️ **E003 与 E005 是全案的支点** —— 它们分别是 causal 与 Gap 的唯一来源。

> 📌 **实操教训（重要）**：E004 最初按"摘要节选"写成 `…to solve software engineering tasks.`，
> **验证不通过**（`form=none`）。真实原文是 `…to solve challenging real-world software engineering problems, such as those proposed in SWE-bench [20].`
> —— 说明**必须逐字抄录完整原文**，不能依赖记忆或摘要改写。这正是 validator 存在的意义。

### 3.4 技术演进（目标：≥1 条真实 improves）

> ⚠️ **本节在实现阶段（Phase 7-2）被证伪，已更正。**
>
> 原设计假设 ReAct=2022 / AutoGen=2023，据此认为会产出 `improves` 因果边。
> 实际解析结果不支持这个假设：两篇 PDF 的 `creationDate` 元数据分别是
> **ReAct = 2023-03-13**、**AutoGen = 2023-10-05**，解析器如实读出 **两个 2023**。
> （ReAct 的 arXiv 首发确是 2022，但这版 PDF 是 ICLR 2023 camera-ready，
> 首页头写着 "Published as a conference paper at ICLR 2023"，解析器读 2023 是正确的。）
>
> 而「年份不能推因果」是算法里一道**正确且刻意**的门：同年 → `same_year_no_order`
> → 直接返回 `temporal`，**先于**一切因果判定。所以 AutoGen→ReAct 因果边
> **不可能**产出。受控实验（同一批真实 quote，仅切换年份）证明：
>
> | 用例 | 年份 | 证据 | 结果 |
> |---|---|---|---|
> | A | 2023 / 2023（真实） | integrate + outperforms | `temporal`（年份门拦住） |
> | B | 2022 / 2023 | "We integrate ReAct into AutoGen…" | **`combines` causal=true** ✅ |
> | C | 2022 / 2023 | "…significantly outperforms ReAct." | **`improves` causal=true** ✅ |
> | D | 2022 / 2023 | 无点名句 | `temporal`（门 B 拦住） |
>
> 结论：门 A / 门 B **完全正常**，唯一拦路的是年份。而 `year` 来自论文解析，
> Provider 结构上无法改（`LLMMethod` 契约里根本没有 `year` 字段）。
> 在「不修改现有算法」的约束下，**当前 Demo 的因果边为 0 是诚实结果**，
> 由 UI 的「为什么没有因果」说明承载，不造边、不改门。

```
当前真实结论：AutoGen 与 ReAct 同年（均 2023）→ 不判因果
  P002::M002 --temporal--> P001::M001
  basis = ["same_year_no_order"]
  （原文确实有点名因果句，但年份无法确立先后，故不建立有向因果箭头）
```

### 3.5 研究空白（目标：≥1 条真实 stated limitation）

```
Gap #1  assertion_level = stated   gap_signal = open_problem
  evidence_ids = [E005]
  来源论文 = P003 (SWE-agent)
  命中规则: /\bunexplored\b/ → open_problem
  通过 FUTURE_WORK 反向过滤 ✅（不含未来工作句式）
  isSubstantive ✅（>12 字符）
```

### 3.6 研究方向（自动传播，无需额外造数）

```
Direction #1  basis_level = stated_backed   （标题无「【推测方向】」前缀）
  唯一上游 = Gap #1
  置信度基线 0.7
```

> **零额外工作** —— 方向模块的唯一输入是 gaps，Gap 成立即自动产出。

---

## 四、最小实现范围建议

### 推荐方案：新增「Showcase Provider」（不改现有算法）

新增一个 provider 实现，**只替换"抽取/分类"这一层的输出**，其余全部走真实算法。

| 项 | 内容 |
|---|---|
| **新增文件** | `server/services/ai/showcaseProvider.ts`（约 120 行） |
| **改动文件** | `server/services/ai/index.ts` 加 1 个 `case`；`config.ts` 加 1 个枚举值 |
| **不改** | `methodEvolution.ts` / `researchGaps.ts` / `researchDirections.ts` / `researchReport.ts` / `evidenceValidator.ts` / 任何 UI |
| **触发方式** | `AI_PROVIDER=showcase`（演示时显式开启，默认仍是 mock） |
| **数据来源** | 按 `file_hash` 匹配已知 PDF → 返回预置 quote；**未匹配则退回 mock 行为** |
| **诚实性** | `source_type` 标 `'demo'`，UI 引擎徽标显示「Showcase 预置数据」 |

**为什么这样最小**：
1. 交接面只有 `extractMethods` / `classifyMethods` 两个方法（其余 provider 方法沿用 mock）；
2. quote 全部取自真实 PDF，`evidenceValidator` **照常拦截** —— 万一写错页号，会被真实校验器挡下，不会污染数据；
3. 下游 4-2/4-4/4-6/4-7/4-8 全部真实运行，Demo 展示的是**真实算法链路**，只是输入被预置。

### 实施前必须先做的事

1. ~~把 quote 的完整原文逐字抄录并跑 validator~~ → **已完成**（5/5 通过，见 3.3）；
2. **确认 `file_hash` 匹配策略**：Showcase provider 需要拿到上传文件的 hash 才能对应到预置数据；
3. **决定 Demo 演示哪条链路**：上传 PDF 触发预置数据，还是直接预置一个完整项目。

> 注：文档中引用的 5 条 quote 已用真实 `quoteMatchesPage` 逐条验证通过，
> 可直接作为实现时的常量表使用。实现后建议再跑一次端到端确认。

### 三条不推荐的做法（避免踩坑）

| 做法 | 为什么不推荐 |
|---|---|
| 改 `mockProvider` 让它产出因果/局限句 | 会污染**所有回归测试**的基线，且 mock 的定位是"永不失败的兜底"，不应承载业务数据 |
| 直接手写 `store/` 里的 JSON | 绕过 `evidenceValidator`，一旦写错页号无从发现 —— 正是本项目最忌讳的一类 |
| 放宽门 A / 门 B | 属于改算法规则，会让"可证伪"这一核心卖点失效 |

---

## 五、风险与诚实性声明

| 风险 | 评估 |
|---|---|
| 是否伪造证据？ | **否** —— 所有 quote 逐字来自真实 PDF，且过真实校验器 |
| 是否绕过算法？ | **否** —— 仅替换抽取层输出，下游算法全部真实运行 |
| 分类是否算编造？ | **否** —— 分类本就是"判定"，依据来自论文真实摘要；reason 可复核 |
| 与 mock 的差别？ | mock 是"规则抽取"，Showcase 是"预置抽取结果"。二者都标 `demo`，不冒充 AI |
| 最大残留风险 | **演示时需说明"预置 Showcase 数据"**，否则观众可能误以为是实时 AI 抽取 |

---

## 六、待用户决策

1. 是否接受「新增 Showcase Provider」这一最小实现范围？
2. 演示形式：**上传触发**（更真实，但需 PDF 已就位）还是**预置项目**（更稳，但少一步演出）？
3. 是否需要我按本设计**实施** Showcase Provider（`AI_PROVIDER=showcase`）？

---

## 附：已交付物

| 文件 | 说明 |
|---|---|
| `docs/phase7-1-showcase-design.md` | 本设计稿 |
| `docs/showcase-candidates.json` | 三篇论文的候选素材勘查结果（方法陈述/因果/局限 候选，含页码） |

**生产代码改动：零。**（`server/` 与 `src/` 今日 18:00 后无任何文件变更）

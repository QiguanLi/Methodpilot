# Phase 7-2 实现说明：离线 Showcase Provider

> 目标：在没有 API Key 的情况下，让比赛 Demo 稳定展示完整链路，且**所有证据仍逐字取自真实 PDF**。
> 约束：只增加一个独立的 showcase 数据路径，**不修改现有算法、UI 和测试语义**。

---

## 1. 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `server/services/ai/showcaseProvider.ts` | **新增** | `ShowcaseAIProvider`，预置 3 篇论文的抽取/分类结果；quote 运行时从真实 PDF 取回 |
| `server/config.ts` | 修改 | `AIProviderName` 增加 `'showcase'`；`resolveProvider()` / `publicConfig()` / `aiModel` 各加一个分支 |
| `server/services/ai/index.ts` | 修改 | `getAIProvider()` 增加 `case 'showcase'` |
| `scripts/showcase-e2e.mjs` | **新增** | Showcase 链路端到端验收（17 项断言），注册为 `pnpm showcase:e2e` |
| `package.json` | 修改 | 增加 `showcase:e2e` 脚本 |
| `docs/phase7-1-showcase-design.md` | 修改 | 更正 §3.4（原因果假设被证伪，见下） |

### 未改动（md5 逐一核对一致）

`methodEvolution.ts`、`researchGaps.ts`、`researchDirections.ts`、`researchReport.ts`、
`ai/evidenceValidator.ts`、`pages/project/EvolutionPage.tsx`、`ai/mockProvider.ts`、`methodAlignment.ts`
—— 8 个文件 md5 全部与实现前一致。

---

## 2. Showcase 数据链路

```
上传真实 PDF
   │  （PDF 解析仍然真实执行：章节、页码、原文全部来自 PDF）
   ▼
AI_PROVIDER=showcase
   ├─ extractMethods()   ← 换这一层：命中预置论文 → 返回预置方法名/核心思想 + 从真实页文本截回的 quote
   │                        未命中 → 调 mockProvider.extractMethods()（行为与普通 mock 一致）
   └─ classifyMethods()  ← 换这一层：命中预置方法名 → 返回确定性 family_id + 理由
                            未命中 → 返回 family_id=null（与 mock 一致，即"未分类"）
   ▼
证据校验 / 方法对齐 / 技术演进 / 研究空白 / 研究方向 / 调研报告
   └─ 全部走**真实算法**，一行都没有绕过
```

### quote 的"不可能写错"设计

preload 里只存 **prefix（索引用前缀）**，不存完整 quote。运行 `pickQuote(pageText, prefix)`：
1. 把页文本与 prefix 都折叠空白后定位（消除 PDF 排版换行差异）；
2. 映射回原文下标，**从原文本截取完整句子**；
3. **只 trim 首尾，内部空白原样保留**（关键：`-\n` 连字符断词必须留给 validator 归一化）。

因此 quote 天然是该页的连续子串，必然通过 `EvidenceValidator`。

---

## 3. 各目标达成情况

| 目标 | 结果 | 证据 |
|---|---|---|
| 3 个方法确定性 family 分类 | ✅ | ReAct→F2、AutoGen→F4、SWE-agent→F1 |
| 所有 evidence 逐字可回验 | ✅ | 7/7 条 page>0 且 quote≥12 字；validator 全 strict |
| ≥1 条真实 limitation → stated Gap | ✅ | GR001、GR002 均为 `stated` |
| Gap 自动传播 → Direction | ✅ | RD001、RD002 均为 `stated_backed` |
| **≥1 条 causal（improves/extends）** | ⚠️ **未达成（诚实为空）** | 见第 4 节 |

---

## 4. 关键更正：因果边为什么（在当前数据下）不可能产出

Phase 7-1 设计假设 ReAct=2022 / AutoGen=2023，据此预期 AutoGen→ReAct 产出 `improves`。
**实现阶段证伪**：

- 两篇 PDF 的 `creationDate` 元数据实际是 **ReAct = 2023-03-13**、**AutoGen = 2023-10-05**；
- 解析器如实读出**两个 2023**（ReAct 这版是 ICLR 2023 camera-ready，首页头即写 "Published as a conference paper at ICLR 2023"）；
- 「年份不能推因果」是算法里**正确且刻意**的门：同年 → `same_year_no_order` → 直接返回 `temporal`，**先于**一切因果判定。

### 受控实验（同一批真实 quote，仅切换年份）

用真实 `buildEvolution` 驱动，把"年份门"与"门 A / 门 B"彻底分离：

| 用例 | 年份 | 证据 | 结果 |
|---|---|---|---|
| A | 2023 / 2023（**真实**） | integrate + outperforms | `temporal`（**年份门拦住**） |
| B | 2022 / 2023 | "We integrate ReAct into AutoGen…" | **`combines` causal=true** ✅ |
| C | 2022 / 2023 | "…significantly outperforms ReAct." | **`improves` causal=true** ✅ |
| D | 2022 / 2023 | 无点名句 | `temporal`（门 B 拦住） |

**结论**：门 A / 门 B 完全正常，唯一拦路的是年份。而 `year` 来自论文解析，
Provider 结构上无法改（`LLMMethod` 契约里根本没有 `year` 字段）。

### 处置决定

在「不修改现有算法」的约束下，**当前 Demo 的因果边为 0 是诚实结果**：
- 不造边、不放宽年份门；
- UI 的「为什么没有因果」说明承载这个空状态；
- 验收脚本把"空"验成"**诚实且可解释**"（断言 causal===0 且每条非因果边都有 description），而不是假装有边。

**全语料仅有 2 句候选因果句**（都在 AutoGen，均点名 ReAct，均被同年拦下）：

```
p24  We integrate ReAct into AutoGen by modifying the prompts in a conversational manner.
p25  …design matches the performance of ReAct, while the three-agent design significantly outperforms ReAct.
```

SWE-agent 全篇只在参考文献里裸引用 ReAct，无因果动词，也不提 AutoGen。

---

## 5. 测试结果

### mock 模式（默认，行为必须不变）

| 套件 | 结果 |
|---|---|
| analyze:test | PASS |
| evolution:test | PASS（132 项断言） |
| gap:test | PASS（128 项断言） |
| direction:test | PASS（153 项断言） |
| report:test | PASS（128 项断言） |
| method-align:test | PASS |
| evolution:ui-test | PASS（67 项） |
| gap:ui-test / report:ui-test | PASS |
| evolution:api-test / gap:api-test / direction:api-test | PASS |
| phase7:demo | PASS |
| `pnpm build` | EXIT=0 |

### showcase 模式

| 套件 | 结果 |
|---|---|
| `pnpm showcase:e2e` | **17/17 PASS** |

### lint

`pnpm lint` → 0 errors（30 个警告均为既有的、与本次改动无关）。

---

## 6. 演示提示

演示时用：

```bash
AI_PROVIDER=showcase pnpm server        # 启动服务
pnpm showcase:e2e                        # 一键验收全链路
```

Demo 可稳定展示：**3 个方法确定性分类** + **真实 stated Gap** + **自动传播的 Research Direction** + **全部证据逐字可回链**。
因果演进边在当前 3 篇论文下如实为空 —— 这是算法的正确行为，UI 会解释原因。

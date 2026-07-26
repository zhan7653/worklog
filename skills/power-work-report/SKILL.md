---
name: power-work-report
description: Settle the user's daily worklog through a confirmation-driven dialogue, assembling captured events into a one-screen review and committing only what the user approves.
---

# Power Work Report(V2:确认对话驱动)

## Overview

本技能不是 CLI 操作说明书,而是一段确认对话的驱动器:把某个本地日已捕获的事件装配成一屏确认面,以**不超过一分钟**的确认成本换取入账。

- **一分钟确认哲学**:一手记录默认通过、仅展示;需要用户点头的只有捞漏候选与完成候选(收工模式下再加当日新增待办的去留)。一分钟预算同时是用户时间预算和上下文卫生预算,超预算即失败。
- **账本是唯一资产**:`ledger/` 之外的一切——day.json、report.md、report.html——都是视图或缓存,可再生。本技能全部产出最终只走 confirmation → ledger 这一条路。
- LLM 匹配层是可拔插的判断层,不是主干:未配置或失败时全流程照常(见 Failure)。

## Triggers

- 用户显式请求结算/对账/生成日报。
- `$power-work-report`。
- 注意到 hook 注入的 `[worklog]` 欠账提示,**且用户同意处理**。提示本身的交互纪律以注入体文字为准:答完当前请求后一句话附带提及,用户未回应则今日不再提,与当前任务无关时勿展开。
- **默认结算节奏是 D+1 开工确认**:开工时结算昨天(或更早的欠账日),不主动结算今天。
- **收工模式**(显式可选):用户说出触发词「收工」时,结算当日。确认后同日再产生的事件,下次结算时作为"已确认日的补充"单列一句确认,不推翻已入账部分。

## Workflow

1. **定目标日 D**。D+1 节奏取最早的欠账日(`wl status` 输出区间的起点);收工模式取今天。多日欠账时从最早一日起逐日走完下述流程,每日摘要压缩更狠。
2. **装配**:`wl assemble --date D`。stdout 一行 JSON 含 day.json 路径。
3. **读 day.json,按一屏呈现**(结构见实现方案 §4.2):
   - `firsthand` 一手记录:**仅展示,不逐条询问**(AC-5)。按项目分组列出即可。
   - `candidates` 捞漏候选与 `completionCandidates` 完成候选:用编号 ①②③… 呈现,**编号跨两个区连续**,并在心里维护"编号 → id"映射(候选用其 `id`,完成候选用其 `todoId`)。
   - 账龄一句:基于 `openTodosSnapshot`,如「未结待办 5 条,最老挂 12 天」。
   - 概览用 `overview.text` 原文,不重写。
4. **把口头补丁翻译成 confirmation**(AC-6)。用户一句话如「①和③算,②不要,④确实完成了,把那条手记文案改成 X,再记个待办 Y」,经编号映射翻译为 §4.3 形状的 JSON,经 stdin 交给校验落盘:

   ```bash
   wl confirm --date D --patch - <<'EOF'
   {
     "date": "D",
     "acceptCandidates": ["c9f0…"],
     "rejectCandidates": ["c7d1…"],
     "editText": [{ "id": "e1a2…", "text": "X" }],
     "completeTodos": [{ "todoId": "t3b4…", "evidence": "commit:a3f2c19" }],
     "addTodos": [{ "text": "Y", "project": "worklog" }],
     "addIdeas": []
   }
   EOF
   ```

   缺省字段视为空数组;未列出的候选一律不入账。confirm 报未知 id 时,核对编号映射后重发,不追问用户。
5. **复述一行待入账摘要**,如「入账:完成 4(含捞回 2)、关闭待办 1、新增待办 1。可以吗?」。
6. **用户点头后**执行 `wl commit --date D`。
7. **一行回执**:report.md 路径 + 入账计数。到此为止,不展开复盘。

## Boundaries

- **day.json 与 report.\* 是生成物,禁止直接编辑**;唯一可编辑物是 confirmation,且只经 `wl confirm` 校验落盘,不徒手写 `days/D/confirmation.json`。
- **未经用户明确点头不执行 `wl commit`**。复述摘要后用户改口,就重新 confirm 再复述。
- **零成本退出**:用户说「待会儿」或不回应 → 什么都不写,立即结束话题;「跳过今天」→ 提交 `{"date":"D","skipDay":true}` 的 confirmation 并 commit,此后不再提。两种情况都不追问。
- **多日欠账逐日最小摘要,禁止长审讯**:三天欠账不许变成三轮审问,每日一屏、一次点头。
- **不主动生成当日报告**,除非用户处于收工模式。
- **无罪恶感文案**(FR-13):任何逃生门的使用不得引来负面反馈,绝不出现「你已连续 N 天未记录」类话术。
- **提醒纪律以注入体为准**:hook 注入的那一行自带交互约束,遵守它即可,不把提醒纪律复述或扩写到别处。
- **候选不越权入账**(AC-11):用户未点头的候选不得以任何形式入账,包括改写成 addTodos/addIdeas 来"帮用户"保留。

## Failure

- **LLM 未配置(`WORKLOG_MATCH_MODEL` 缺失)或匹配调用失败**:照常走确定性流程——候选原样展示、概览为模板句(「共 N 条记录覆盖 M 个项目。」),确认与入账不受任何影响(AC-9)。不重试、不换模型、不向用户报错致歉。
- **assemble / confirm / commit 显式报错**(stderr + 非零退出):向用户转述一行错误后停止,不半途 commit。commit 事务幂等,可安全重试。

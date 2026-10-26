# dsh-loop-guard · 防烧钱守卫

新增功能见 [预算详情与插件联动](FEATURES-2026-10-27.md)：点击用量徽标查看每日预算、消耗排行和拦截原因。

🔊 DSH 的一个本地插件。它不看内容、不调模型、不花一分钱，只做一件事：在工具调用真正发生之前，按几条纯算术的规则判断「这一步是不是又白烧钱」，是就拦下。

装好之后，一轮问答的累计计费输入（含这一轮生出来的子代理）到 6000 万、整个会话累计到 10 亿 token 会硬停手，同一条命令反复跑会拦，两种写法乒乓循环会拦，同一个错误反复出现会拦，子代理扇出失控会拦。

**它不由模型自觉，它由代码执行。** 这跟 `~/.dsh/skills/no-waste-loop-guard/` 那个技能是配套的（技能是用户级文件，不在本仓库）：技能负责「我自觉」，插件负责「我赖不掉」。

## 万一它把你自己锁住了：怎么停手

守卫有可能自己出毛病（改判据改错了、账本算歪了），而修它本身又需要工具调用 —— 那就成了死循环。所以停手的路子必须**不需要模型参与**：

| 出口 | 怎么做 | 生效速度 |
|---|---|---|
| **插件市场里的启用开关**（首选） | 设置 → 插件市场 → 已安装 → 把这个插件的「启用中」关掉 | **下次启动**（见下） |
| **只解锁预算门**（不关插件） | 删掉存档 `~/.dsh/loop-guard-state.<profile>.json` 里该会话那条记录（存档只写数字，删掉就当全新会话；认不出 profile 时退回老路径 `~/.dsh/loop-guard-state.json`），或调高 / 设 `0`：`DSH_LOOP_GUARD_MAX_TOKENS`、`DSH_LOOP_GUARD_SESSION_MAX_TOKENS` | 重启后 |
| 卸载 | `pwsh -File ...\uninstall.ps1`，然后完全退出 DSH 再打开 | 重启后 |

**注意：市场里那个开关对这个插件不是热生效的。** 关插件时市场会调 `hotUnmount`，而它只对「市场自己热挂载起来的插件」有句柄（`hotHandles`）—— 本插件是启动时由 profile 的 `dsh.profile.bundles` 层加载的，拿不到句柄，于是退回写一条禁用标记，那条标记要到下次启动才被读到。所以对这个插件来说，那个开关 = **关掉 + 重启一次**。

也就是说：**这个插件的任何开关或改动，生效时间都是「下次启动 DSH」。** 好处是不用担心热更新把正在跑的东西弄乱；代价是被锁住时要重启一次 —— 对人来说这一步很便宜，所以够用。

（曾经写过一个「保险丝文件」：放一个空文件就立刻停手、不用重启。核实完市场开关后确认它已经覆盖这个场景，就删掉了，少一样要维护的东西。）

## 装在哪

```
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-loop-guard\    ← 运行时读的（真实目录，不是软链）
%USERPROFILE%\.dsh\local-plugins\dsh-loop-guard\                    ← 源码与测试
```

登记在 profile 的 `package.json` 里，两处都必须有：

- `dsh.profile.bundles` 数组里有 `"dsh-loop-guard"`
- `dependencies` 里有 `"dsh-loop-guard": "file:../../local-plugins/dsh-loop-guard"`

用 `file:` 是故意的：将来跑 `pnpm install` 时它既不会去 registry 找，也不会因为 lockfile 里缺条目而把整组 bundle 拖回滚。

改完源码之后要同步过去：

```powershell
$src = "$HOME\.dsh\local-plugins\dsh-loop-guard"
$dst = "$HOME\.dsh\profiles\desktop\node_modules\dsh-loop-guard"
Copy-Item "$src\lib" -Destination $dst -Recurse -Force
Copy-Item "$src\package.json","$src\cordis.patch.yml" -Destination $dst -Force
```

**插件只在 DSH 启动时加载一次。** 装完、改完，都要完全退出 DSH 再打开才生效（关窗口不算，要确认进程真的退了）。

## 从 GitHub 安装（给别人用）

仓库：https://github.com/514koishi-495/dsh-loop-guard

```powershell
git clone https://github.com/514koishi-495/dsh-loop-guard "$HOME\.dsh\local-plugins\dsh-loop-guard"
```

目录名要保持 `dsh-loop-guard`（`dependencies` 里那条 `file:` 路径按它写）。然后在 profile 的 `package.json` 里登记两处：`dsh.profile.bundles` 加 `"dsh-loop-guard"`、`dependencies` 加 `"dsh-loop-guard": "file:../../local-plugins/dsh-loop-guard"`（相对 profile 目录的路径），**完全退出 DSH 再打开**才生效。

配套技能 `no-waste-loop-guard` **不在本仓库** —— 它是用户级技能，装在 `%USERPROFILE%\.dsh\skills\no-waste-loop-guard\SKILL.md`，要另外带过去。

## 闸门一览

| 闸门 | 触发条件 | 默认值 | 拦截码 |
|---|---|---|---|
| 本轮预算 | 这一轮问答的计费输入到线 —— **含这一轮生出来的所有子代理** | 6000 万 | `LOOP_GUARD_BUDGET_EXHAUSTED` |
| 会话总预算 | 整个会话跨轮累计到线（只算本会话自己） | 10 亿 | `LOOP_GUARD_SESSION_BUDGET` |
| 家族预算 | 自己 + 所有后代的累计到线（不按轮重置） | 不设限 | `LOOP_GUARD_FAMILY_BUDGET` |
| 同签名重复 | 同工具同参数（命令会归一化）反复调 | 4 次（`read` 5 次） | `LOOP_GUARD_REPEAT` |
| 同骨架重复 | 只换数字/引号的同一件事。只对命令行生效；`read` 只折 `offset`/`limit`，路径原样保留；其余工具用精确签名 | 10 次 | `LOOP_GUARD_SKELETON` |
| 乒乓循环 | A B A B A B 整体在打转 | 3 轮 | `LOOP_GUARD_CYCLE` |
| 同一个错误 | 「工具名 + 归一化错误正文」这个指纹反复出现；**只拦报错的那个工具**，别的工具照常放行（不然连诊断用的读文件都会被堵死） | 2 次 | `LOOP_GUARD_SAME_ERROR` |
| 子代理请求数 | 单个子代理的模型请求数 | 150 | `LOOP_GUARD_SUBAGENT_REQUESTS` |
| 子代理工具数 | 单个子代理的工具调用数（只算真的执行过的调用） | 250 | `LOOP_GUARD_SUBAGENT_TOOLS` |
| 横向异常 | 单个子代理每次请求的均值超过兄弟们的中位数 | 5 倍（至少 3 个兄弟） | `LOOP_GUARD_OUTLIER` |
| 空跑熔断 | 连着一个字都不返回还继续烧 | 3 次 | `LOOP_GUARD_BREAKER` |
| 扇出到顶 | 同时活着的子代理数 | 8 | `LOOP_GUARD_FANOUT` |
| workflow 扇出 | 脚本里 agent() 调用 × args 里的条目数 | 24 | `LOOP_GUARD_WORKFLOW_FANOUT` |
| 软着陆 | 到线后只拦贵的工具 | 关 | `LOOP_GUARD_SOFT_LANDING` |

「计费输入」= `inputTokens + cacheReadTokens + cacheWriteTokens`，也就是钱按这个数算；`inputTokens` 只是没命中缓存的那一份，光看它会严重低报。

**工具计数口径**：账本里的 `toolCalls` 只记**真的执行过**的工具调用（含交账白名单里的那些）；被闸门拦下、根本没执行的调用一项都不记 —— 所以一次被拦的调用既不吃子代理工具配额，也不会把「首超一次」的配额豁免白花掉。白名单工具记一次 `toolCalls`，但**不算「本轮干过活」**（`turnToolCalls` 不动），收尾动作因此搅不乱纯输出门的判据。

**逃生门分两种语义**：重复类闸门（同签名 / 同骨架 / 同错误 / 乒乓循环 / 横向异常）与三道预算门（本轮 / 会话 / 家族）是「同一处连拦 3 次，放行一次」；配额类闸门（子代理请求数 / 子代理工具数 / 扇出并发 / workflow 扇出 / 空跑熔断）是「首超那次放行一次，此后一直拦」。两种放行都打 warn。乒乓循环门也在这一串里：逃生门放行那一次，紧接着的同签名调用不会再被它顺手拒掉。

### 预算里的三笔账，分别管哪一段时间

- **本轮预算（默认 6000 万）** = 这一轮问答里，**自己 + 这一轮生出来的所有子代理（含孙辈）**。
  子代理必须算进来：只算自己的话，一次对话可以自己烧满 6000 万，再让 8 个子代理各烧 6000 万，单轮上限就形同虚设。
  它是**按轮清零**的 —— 子代理的消耗落在「它花钱时自己那一轮」，所以父会话换到下一轮，上一轮的子代理账就不算进新预算。
  后台子代理（`run_in_background`）会跨轮活着，它的消耗落在「它花钱时父会话正处在的那一轮」，这是有意的：账跟着时间走，不跟着出生走。
  换轮的判据只有一个：宿主 usage 事件里的 `turn` 变了。**一轮 = 一条用户消息，以及它之后的全部工作**（工具调用、子代理、模型往返）。
  **用户在模型干活中途插入的消息不算新一轮** —— 它仍算在那条消息的那一轮里，所以中途插话不会把本轮账清零，也不会松开已经到线的保险丝。
- **会话总预算（默认 10 亿）** = 只算**本会话自己**的跨轮累计，不含子代理。
- **家族预算（默认不设限）** = 自己 + 所有后代的**跨轮**累计。想要「整个会话连同子代理不超过 10 亿」，把 `DSH_LOOP_GUARD_FAMILY_MAX_TOKENS` 设成 `1000000000`。

一句话分工：**本轮 = 这一轮含后代；家族 = 整场含后代；会话 = 整场只算自己。**

### 「同一个错误」这条闸门到底认什么

这条闸门最容易帮倒忙，所以口径写清楚：

- **只有「同一个工具 + 同一个错误」才算。** 指纹是 `工具名 + 归一化错误正文`，A 工具的错误不会把 B 工具拦住。
- **插件自己的拒绝不算错误。** 拒绝载荷带 `error.name === 'LoopGuard'` / `error.code` 以 `LOOP_GUARD` 开头 / 正文里有 `【防烧钱`，一律跳过 —— 否则「被拦」会喂养「再拦」，而拒绝文本里嵌着上一次的拒绝文本，会一层套一层滚大。
- **瞬时 / 外部故障不算。** 网络层错误码、HTTP 方法后跟 URL、`429`、`500/502/503/504`、`rate limit`、`timed out` 都跳过：重试一次是合理的，不是原地打转。判据宁松勿严 —— 漏记一次只是少拦一次，误判一次就把人锁住。
- **报错的工具自己成功了，标志就放下。** 别的工具跑通不算（那不代表这个坑填上了）。
- 失败载荷两种形状都认：摊在事件顶层的 `name`/`code`/`reason`，以及收在 `data.error` 下面的那一份。

## 两个不许破的原则

1. **绝不把 agent 锁死。** 每一处拦截都带逃生门，但**分两种语义**：
   - **重复类闸门**（同签名 / 同骨架 / 同错误 / 乒乓循环 / 横向异常）与**三道预算门**（本轮 / 会话 / 家族）：同一处连拦 `maxDenials`（默认 3）次之后一律放行一次。
   - **配额类闸门**（子代理请求数 / 子代理工具数 / 扇出并发 / workflow 扇出 / 空跑熔断）：**首超那一次 warn + 放行一次**（一次性豁免），此后每次都拦 —— 它是钱的上限，不是重复检测，不能变成「以 1/4 的速率继续花钱」。**豁免记录随会话落盘**：注销时把该会话的计数连同门的记忆（`quotaExempted` / `escape` / `escapeSig` / `escapeSigUsed`）一起 park 进存档，同一个会话 id 复活后接着数，不重领一次豁免。
   两种放行都**必须打 warn 日志**（静默放行等于偷偷烧钱）。逃生计数**按签名**计的门（同签名 / 同骨架 / 同错误 / 乒乓）是会话级、换轮不清零；三道预算门各自按预算周期独立计数 —— 会话门按会话、家族门按家族、**本轮门每换一轮就是新的「拦 3 放 1」节奏**（key 里带轮次） —— 这条是用一次真实事故换来的：标志是粘性的、计数每轮归零，两个加起来就是永久锁死（详见 `CHANGELOG.md` 的 1.1.2）。
2. **记账失败不许拦住会话。** 事件字段对不上、磁盘写不进去、诊断日志写不进去，都只让守卫变瞎，不让会话出错。为了不变成「安静的哑巴」，跑了 20 次工具还收不到任何 usage 样本时会自己吼一声。

**预算到线之后是粘性的**：到线即拦（就在那一轮内也不会自动放行），换轮、重启都不解锁 —— 累计计数是从存档恢复的，重启之后它仍然在线上。到线了还能收尾靠两件事：① **免拦工具**（见下一节）在预算门**之前**判定，永远放行；② 同一处连拦满 `maxDenials` 次后保险丝放行一次。想主动解锁见上面「万一它把你自己锁住了」一节。

重启后 `totalInput` 从存档恢复，所以**工具类预算门会立刻再次到线**；但 `vetoNewTurn`（默认关）靠内存里的 `trippedSession` / `trippedSessionTurn` 判断，而存档只写数字（v2 的 `sessions` / `retired` / `stats`）、`loadState` 不回填这几个 `tripped*` 标志 —— 所以「禁止开新一轮」的否决要到本会话下一次工具调用把会话门重新踩到才生效。

## 永不拦的工具

`todo_write` `todo_read` `job_list` `job_output` `job_kill` `ask_user_question` `update_goal` `get_goal` `acp_status` `acp_cache` `search_context`

—— 这些要么是收尾、要么是跟人说话，拦了只会让它卡死。

## 环境变量

阈值不用改代码，改环境变量就行；技能里写的数字只是默认口径。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_LOOP_GUARD_MAX_TOKENS` | `60000000` | 本轮上限（6000 万，与常驻纪律的 60M 天花板对齐），**含该轮子代理**；设 `0` 或负数 = 不设限 |
| `DSH_LOOP_GUARD_SESSION_MAX_TOKENS` | `1000000000` | 会话累计上限，只算本会话自己；设 `0` 或负数 = 不设限 |
| `DSH_LOOP_GUARD_FAMILY_MAX_TOKENS` | 不设限 | 家族上限（自己 + 所有后代）；设 `0` 或负数 = 不设限。想让「会话累计」也含后代，把它设成和会话上限一样的值 |
| `DSH_LOOP_GUARD_WARN_RATIO` | `0.7` | 用到几成开始预警 |
| `DSH_LOOP_GUARD_REPEAT_LIMIT` | `4` | 同签名 |
| `DSH_LOOP_GUARD_READ_REPEAT_LIMIT` | `5` | 读文件单独放宽 |
| `DSH_LOOP_GUARD_SKELETON_LIMIT` | `10` | 同骨架 |
| `DSH_LOOP_GUARD_CYCLE_LIMIT` | `3` | 乒乓循环 |
| `DSH_LOOP_GUARD_SAME_ERROR_LIMIT` | `2` | 同一个错误 |
| `DSH_LOOP_GUARD_SAME_ERROR_UNKNOWN_LIMIT` | `3` | 同错误门认不出报错工具名（只能全局拦）时，连续拦几次后受限降级、不再拦这一种分支；设 `0` = 从不降级 |
| `DSH_LOOP_GUARD_MAX_DENIALS` | `3` | 逃生门：同一处连拦几次后放行一次（最小钳到 `1`：它是保险丝不是闸门，`0` 只会让它更早熔断，不会锁死） |
| `DSH_LOOP_GUARD_MAX_FANOUT` | `8` | 同时活着的子代理 |
| `DSH_LOOP_GUARD_FANOUT_TTL_MS` | `1200000` | 多久没动静算它已经死了 |
| `DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS` | `24` | workflow 内子代理 |
| `DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS` | `150` | 子代理请求数 |
| `DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS` | `250` | 子代理工具数 |
| `DSH_LOOP_GUARD_OUTLIER_RATIO` | `5` | 横向异常倍数 |
| `DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS` | `3` | 至少几个兄弟才比较 |
| `DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS` | `5000000` | 太小不判异常 |
| `DSH_LOOP_GUARD_EMPTY_RESULT_TOKENS` | `20000000` | 熔断：花到多少还空手 |
| `DSH_LOOP_GUARD_EMPTY_RESULT_OUTPUT` | `500` | 熔断：输出少于多少字算空手 |
| `DSH_LOOP_GUARD_MAX_BATCH_FAILURES` | `3` | 熔断：连空几次 |
| `DSH_LOOP_GUARD_PURE_TALK_TOKENS` | `200000` | 纯输出门：**自本轮最后一次真的执行过工具调用以来**又累计吐了这么多输出 token 才算「纯输出烧钱」；设 `0` 或负数 = 关掉这道门 |
| `DSH_LOOP_GUARD_PURE_TALK_GUARD` | `1` | 纯输出门命中后是否动作（停止生成 + 提醒交账）；设 `0` = 只关动作，计数与统计照旧 |
| `DSH_LOOP_GUARD_VETO_NEW_TURN` | `0` | 到线后否决新一轮（默认关：`agent/pre-step` 的 `reject` 是**空决定**，带不了任何解释，用户会被静默闷住，所以默认只拦工具、留一条「模型还能说话」的路） |
| `DSH_LOOP_GUARD_SOFT_LANDING` | `0` | 软着陆 |
| `DSH_LOOP_GUARD_PERSIST` | `1` | 设 `0` = 不写盘（重启后计数从零开始），**也不写诊断日志** |
| `DSH_LOOP_GUARD_NO_PERSIST` | — | 设 `1` = 等价于 `PERSIST=0`（不写盘、不写日志） |
| `DSH_LOOP_GUARD_COST` | `1` | 估算本会话消耗金额并显示在会话头徽标第三段；设 `0` = 不算也不报（端点响应里连 `cost` 键都不出现），**旧会话的金额也不补算**（见「旧会话的金额补算」一节） |
| `DSH_LOOP_GUARD_PRICE_TABLE` | 空（用内置价目表） | 给一段 JSON 整体覆盖内置价目表（形状见「会话头「消耗」估算」一节）；解析失败或形状不对只 warn 一次并回落内置表 |
| `DSH_LOOP_GUARD_STATE_FILE` | `~/.dsh/loop-guard-state.<profile>.json` | 存档路径（认不出 profile 时退回 `~/.dsh/loop-guard-state.json`；**启动时**读一次，改完要重启；显式指定时**不做**老存档迁移） |
| `DSH_LOOP_GUARD_LOG` | `1` | 设 `0` = 只关诊断日志，计数照常写盘 |
| `DSH_LOOP_GUARD_LOG_FILE` | `~/.dsh/loop-guard.log` | 诊断日志路径（**启动时**读一次，改完要重启） |
| `DSH_LOOP_GUARD_OFF` | — | 设 `1` = 整个插件不装任何钩子（**启动时**读，要重启；等价于面板里的 `off`） |

上面这些**计数类**阈值（`REPEAT_LIMIT` / `READ_REPEAT_LIMIT` / `SKELETON_LIMIT` / `CYCLE_LIMIT` / `SAME_ERROR_LIMIT` / `MAX_FANOUT` / `MAX_WORKFLOW_AGENTS` / `MAX_SUBAGENT_REQUESTS` / `MAX_SUBAGENT_TOOLS` / `OUTLIER_MIN_SIBLINGS` / `MAX_BATCH_FAILURES`）设成 `0` 或负数 = **关掉那道门**。判据是 `已发生次数 >= 阈值`，阈值 `0` 会让它恒真 —— 一个 `CYCLE_LIMIT=0` 就能把整个会话每一步都拦掉，所以一律钳成「不设限」。

## 会话头用量徽标

会话头右侧有一个小徽标（`lib/client.js`，浏览器半边），把用量摆在眼前：`会话 1.6M · 本轮 620.0K · 消耗 ¥5.02`。第三段是金额估算（见下一节）；拿不到估算时它**整段不出现**，连那个分隔符一起，不会显示成 `¥0`。

- 两个数字都是**计费输入**（`input + cacheRead + cacheWrite`），会话那格是跨轮累计、本轮那格含这一轮生出来的子代理；有预算门到线时徽标变红，悬停会写明是哪一道（本轮 / 会话 / 家族）。
- 数据来自同源只读端点 `GET /api/loop-guard/usage?sessionId=<会话 id>`，间隔 **≥1500ms**（计时从一次请求结束后重新起算，上一次请求自己的耗时不计在内）；失败后按 1.5s → 3s → 6s → 10s 退避封顶、成功即恢复，失败期间整个不显示；单次请求 10s 内既不回也不报错会被**主动中止**并走失败路径（挂死的端点不会把徽标卡在「永远在飞行」）—— 守卫的界面绝不能成为弄坏会话头的东西。
- 响应形如 `{"ok":true,"sessionId":"…","session":{"totalInput":…,"familyInput":…,"output":…,"requests":…,"modelCalls":…,"toolCalls":…,"turn":…,"lastSeen":…},"turn":{"input":…,"familyTurnInput":…,"total":…},"limits":{"maxTokens":…,"sessionMaxTokens":…},"tripped":{"turn":false,"session":false,"family":false},"updatedAt":…}`；缺 `sessionId` 回 400，未知会话回 200 + 全 0（不是 404）。
- 非 `GET` 一律回 405 `{"ok":false,"error":"method-not-allowed"}`（`POST` / `HEAD` / 小写 `get` 实测都是 405），不去碰业务逻辑。
- 宿主没有 web server 时它什么都不注册，插件照常工作。

## 会话头「消耗」估算

徽标第三段 `消耗 ¥5.02` 是**估算，不是账单** —— 本机不存在按会话的真账单（宿主只给账号级余额和 token 级用量），只能按「本会话 token × 本地价目表」推。中文文案就两条：`消耗`（`badge.cost`）与悬停里的 `估算 {cny}`（`badge.costTitle`）。

- **价目表**（元 / 百万 token，每项两列 = 平价 / 峰价；`pricesAsOf` = `2026-10`）：flash（`default` 行）`cacheHit 0.02 / 0.04`、`inputMiss 1.0 / 2.0`、`output 4.0 / 8.0`；pro 行 `0.15 / 0.3`、`4.5 / 9.0`、`13.5 / 27.0`。算式是 `cacheRead × cacheHit + (input + cacheWrite) × inputMiss + output × output`，其中**未命中输入 = `inputTokens + cacheWriteTokens`**；结果按 2 位小数报（元级别不需要更多位，也顺手抹掉浮点噪声）。金额与估价用的输入拆分随存档落盘，重启后接着涨。
- **峰窗口**：北京时间**周一至周五** `[09:00,12:00)` 与 `[14:00,18:00)`，其余时段按平价列（约为峰价一半；周末整天平价）。每一笔样本按**它自己的到达时刻**选列，不是整天一个价。**中国法定节假日没有特判** —— 节假日官方不按峰价收，本插件照峰窗口算，会偏高约一倍。
- **v4-pro 已并入 flash 计价**：`2026-09-14T04:00:00Z`（北京时间 2026-09-14 12:00）之后 v4-pro 一律按 flash 行估，`pro` 行只对折叠前的时刻有意义（`DSH_LOOP_GUARD_PRICE_TABLE` 里的 pro 行同理）。
- **口径**：只算**本会话自己**的 token，**不含子代理**（与会话门一致）。模型名取最近一次 `request/header` 或 `request/context` 里的**裸模型名**（原样存，不改大小写）；取不到就按 flash 行估。选 pro 行的判据是「名字里含 `pro`（不区分大小写）**且**早于折叠时刻」—— 比上游的 `includes('v4-pro')` 宽，`V4-PRO-0528` 这类也认得出。
- **两个旋钮**：`DSH_LOOP_GUARD_COST=0` 整段不出现；`DSH_LOOP_GUARD_PRICE_TABLE` 给一段 JSON 可整体覆盖内置表（形状 `{"default":{...},"pro":{...}}`，每项都是 `[平价, 峰价]` 两个非负数，两行都必填），JSON 非法或形状不对只 warn 一次并回落内置表 —— 估价既不能让插件加载失败，也不能静默用错表。

## 旧会话的金额补算

本版（1.1.7）之前就开始记账的会话，存档里**没有金额所需的拆分**（`cacheReadInput` / `uncachedInput` / `costCny` / `lastModel` 全是 `0`），而「会话累计输入」是会被存档原样恢复的 —— 于是徽标出现「会话 16.2M」配「消耗 ¥0.00」这种落差：token 是真的，钱不是。

- **何时补、怎么补**：会话打开时（`session/created`），若账本已存在（`requests > 0`）、没被退休、钱估算开着（`DSH_LOOP_GUARD_COST=1`）、且 `cacheReadInput + uncachedInput` 仍是 `0`（＝本版之前的老账），就用宿主的 `session.snapshotEvents()` 把历史事件**只补金额**：`request/header` → `data.header.config`、`request/context` → `data`（取裸模型名选价目表行），每条 usage 只累加 `cacheReadTokens` → `cacheReadInput`、`inputTokens + cacheWriteTokens` → `uncachedInput`、以及按价目表算出的金额。`DSH_LOOP_GUARD_COST=0` 期间打开的老会话这一轮不补；等开关打开后再打开它（或下次会话打开时），拆分仍是 `0`，所以照样会补一次。
- **token 一个字都不动**：`totalInput` / `familyInput` / `requests` / `modelCalls` / `toolCalls` / `turn` / `turnInput` 七项，连同家族 / 祖先上卷，全部原样；`requests === 0` 的新会话照旧走原来的完整重放（补算的遍历顺序与它逐条同序），逻辑未改。
- **幂等、也没多出字段**：补算成功后拆分不再为 `0`，所以重启、重开会话都不会重复计；历史里没有 usage 事件时它是一次**无害空操作**。**没有新增存档字段，存档版本号仍为 `2`。**
- **一次性，并留一行日志**：每个老会话只补一次，写一行 info 日志（只含计数，绝不含对话内容）：`旧账补算 会话 <id>：历史 N 条 → cacheRead=… uncached=… 金额=…（只补金额，token 一概未动）`；这行同时落进诊断日志文件（见「诊断日志」一节）。
- **近似与边界**（如实说）：补算里**每笔历史样本的价格列统一按补算当刻**选（不像在线样本那样按各自到达时刻选平价 / 峰价列），所以峰谷判断对老账只是近似；能补多少完全取决于宿主快照事件里还剩多少历史（**没有 usage 事件就补不出钱**）；宿主事件若不带缓存字段，则诚实地退化成一整笔未命中输入（`inputTokens + cacheWriteTokens`），不猜拆分。
- 补算全程在既有 `try/catch` 里：**失败只影响金额，绝不拦住会话**。

## 跨重启记账

「一次问答」很容易跨一次 DSH 重启。存档只写数字，不写任何对话内容；**退休会话名单也落盘**（`retired`，跨重启不重放 —— 重启后不会把已经退休的会话当成新会话又放行一笔）：

```
{ "version": 2, "savedAt": "...", "sessions": { "<会话 id>": { "totalInput": 950000000, ... } }, "disposed": [ { "id": "<已注销会话 id>", "disposedAt": "2026-10-14T18:41:02.712Z", "totalInput": 24857000, "familyInput": 24857000, "output": 312400, "requests": 13, "modelCalls": 13, "toolCalls": 7, "turn": 4, "turnInput": 9800000, "familyTurnInput": 9800000, "cacheReadInput": 24100000, "uncachedInput": 757000, "costCny": 3.1482, "lastModel": "deepseek-v4-flash", "quotaExempted": { "subagent-tools": true }, "escape": { "sign-1": 2 }, "escapeSig": "<上一次逃生门放行的签名>", "escapeSigUsed": false }, { "id": "<更早注销的会话 id>", "disposedAt": "...", "totalInput": 2600000, ... } ], "retired": [ "<退休会话 id>", ... ], "stats": { "sessions": 5, "denied": 8, "released": 1, "exempted": 2, "updatedAt": "..." } }
```

`stats` 是只读统计段，字段就五个：`sessions` / `denied` / `released` / `exempted` / `updatedAt` —— 只增不减地跨重启累加，不参与任何门控。本轮账（`turnInput`）也一起落盘，所以重启之后本轮预算不会假装「这一轮还没花过钱」。

存档按 profile 分片：`~/.dsh/loop-guard-state.<profile>.json`；首次启动若发现旧路径 `~/.dsh/loop-guard-state.json` 还在，就把**旧文件整个改名**为 `loop-guard-state.json.migrated` —— 迁移是**文件级**的一次性动作，不做项目级覆盖。

`disposed` 段（1.1.7 内新增，纯加字段，缺它的旧档照常加载，**存档版本号仍是 `2`**）就是「已注销账本」：宿主崩溃 / 重启会把在跑的会话逐个注销，注销时把它的账本 park 进这一段，同一个会话 id 再出现时直接恢复计数接着算 —— 链路见下一小节。

### 崩溃 / 重启后同一会话接着算

宿主崩溃或重启会把在跑的会话**逐个注销**。注销时每一段账都必须留住，否则重启之后同一个会话 id 复活，数字会凭空少一截。1.1.7 之前正是这样：注销直接把该会话的账本从内存**和存档**里一起丢掉，重启后同一个 id 因为已在退休名单（`retired`）里、历史重放被跳过，计数**从零重数**。实测：本会话崩溃前累计计费输入 `2485.7 万` token（真日志 `~/.dsh/loop-guard.log` 里 `[2026-10-14T18:41:02.712Z]` 那行收尾摘要写着），重启后存档里只剩 `260 万 / 13 次请求`，徽标于是显示 260 万。

链路是四步：

1. **注销时 park** —— `session/disposed` 把该会话的 13 项计数（7 项原有 + `turnInput` / `familyTurnInput` / `cacheReadInput` / `uncachedInput` / `costCny` / `lastModel`）**外加 4 项门的记忆**（`quotaExempted` / `escape` / `escapeSig` / `escapeSigUsed`）连同 `disposedAt` 留在存档的新段 `disposed` 里；登记本身按 10 秒节流的写盘节奏与其余状态一起落盘。
2. **复活时恢复** —— `session/created` 见到同一个会话 id 且 `disposed` 里还留着它的条目，就**直接把这些计数与门的记忆灌回账本**，接着算。
3. **不重放、不重复上卷** —— 恢复路径不读宿主历史事件，所以既不会把同一段历史算第二遍，也**不向祖先上卷**（那笔钱在它活着的时候已经上卷过了，再上卷一次就是凭空多扣）。「退休名单」（`retired`，上限 2000、FIFO）的职责本版收紧为：**没有**可恢复的 parked 账本时它才是「不许重放这段历史」的依据；有 parked 账本时一律以恢复的计数为准（1.1.7 之前见到 `retired` 就跳过，会把可恢复的那份计数一起丢掉）。
4. **留一行 info 日志** —— 只含计数、绝不含对话内容：`会话复活，接着算：<id> ← 退休前 计费输入 <N> token、请求 <N> 次、轮次 <N>、金额 ¥<x>（不重放历史，也不给祖先重复上卷）`。

parked 条目被淘汰时**仍是老行为**：`disposed` 最多 200 条、按插入顺序淘汰最旧一条（FIFO）；超出 200 条之外的老会话没有可恢复的账本了，于是**从零重数**，历史数字只留在诊断日志的收尾摘要里（见上一小节与「诊断日志」一节）。

写盘是节流的（10 秒最多一次），只保留花得最多的 200 个会话。写盘走 `tmp` + `rename`（不会留下半个文件）。读盘失败一律当第一次跑；**解析前先剥掉开头的 U+FEFF**（存档与 `DSH_LOOP_GUARD_PRICE_TABLE` 都剥：Windows 编辑器存过的 BOM 不会被判成格式非法）；存档 `version` 对不上时**按已知字段尽力迁移**（`totalInput` / `familyInput` / `turn` 等都保留），只打一条 warn，不再整份丢弃 —— 把历史计数丢掉等于预算门形同虚设。

## 诊断日志

守卫把「它正在放行」的信号也落一份文件，方便事后复盘（`ctx.logger` 只在运行中看得到）：

- 默认 `~/.dsh/loop-guard.log`，用 `DSH_LOOP_GUARD_LOG_FILE` 覆盖（**启动时**读一次）。
- 只写 warn/error 这几类：**逃生门放行**、**预算门首次到线**、**盲区自检**（跑了 20 次工具却一个 usage 样本都没收到）、**存档版本迁移**、**写盘失败**、**FIFO 淘汰**（含逃生计数表满时淘汰了哪个签名、本次要用的那个 key 不受影响）；外加两类 info：**旧账金额补算**（`旧账补算 会话 <id>：历史 N 条 → …`）与**崩溃 / 重启后同一会话复活接着算**（`会话复活，接着算：<id> ← …`）—— 两条都只含计数，绝不含对话内容。
- 单文件上限 2MB，超了整体轮转成 `loop-guard.log.1`（只留一份，更旧的那份被覆盖）；同一条消息 10 秒内只写一次，免得一秒钟刷几千行。
- **写日志失败不影响闸门**：出错就置一个标志位、此后不再尝试，判定照常；`PERSIST=0` / `NO_PERSIST=1` 时连日志一起关。

## 测试

```powershell
$d = "$HOME\.dsh\local-plugins\dsh-loop-guard"
node "$d\test\smoke.mjs"            # 48/48：老闸门
node "$d\test\guards.mjs"           # 361/361：新闸门（含「本轮预算算不算子代理」「36. 旧账金额补算」、C1-C14 契约用例、「37 日志安全化」与「38 崩溃 / 重启后同一会话接着算」两组）
node "$d\test\persist.mjs" write    # 21/21：写得进去（含真账本 / 真日志隔离）
node "$d\test\persist.mjs" read     # 26/26：读得回来并据此拦人
node "$d\test\persist.mjs" migrate  # 28/28：存档版本对不上时按已知字段迁移

# 合计 484 项（48 + 361 + 21 + 26 + 28），全部通过，五条命令退出码都是 0
```

三个脚本都在动态 `import` **之前**把 `DSH_LOOP_GUARD_STATE_FILE` / `DSH_LOOP_GUARD_LOG_FILE` 指到 `test/` 下（这两个路径是模块加载时读一次的，写在 `import` 之后就是死代码），跑完各留一条断言：真账本与 `~/.dsh/loop-guard.log` 的 SHA256 一字未变，临时文件在结束时删掉。那条「真账本」断言盯的是**旧全局路径** `~/.dsh/loop-guard-state.json`，而本机活账本早已按 profile 分文件（`loop-guard-state.<profile>.json`），所以在这台机器上它**如实退化为「旧路径未被创建 / 改写」**，并打印一行 `SKIP 真账本 <旧全局路径> 不存在（本机已改用按 profile 的账本），本断言退化为「旧路径未被创建/改写」`（尖括号处脚本打印的是真路径，本文按不写本机绝对路径的约定留占位） —— 那是缺省前提下的退化，不是被吞掉的空转。跨重启那一项必须分两个进程跑——账本是模块级的，一个进程里只能干净地测「写」「读」或「迁移」。

上面那些数字是**实跑**得到的（同一台机器、同一份工作区），每条命令的最后一行如下：

```text
node test/smoke.mjs            退出码 0  通过 48/48；next() 被调用 33 次
node test/guards.mjs           退出码 0  通过 361/361
node test/persist.mjs write    退出码 0  [persist/write] 通过 21/21
node test/persist.mjs read     退出码 0  [persist/read] 通过 26/26
node test/persist.mjs migrate  退出码 0  [persist/migrate] 通过 28/28
```

五条里各有一对隔离断言同时通过，其证据是同一份真日志 SHA256（`9dfe2bcb8e1f5396fccb403c5470b155fce2e180a840da32c611b536b2155e5c`），真账本在测试机上 `<absent>`（本机本来就没有旧全局路径 `~/.dsh/loop-guard-state.json`，所以那一对断言如实退化为「旧路径未被创建 / 改写」）。

「旧账金额补算」那行在本机实测日志里看得到（脚本断言里就是这一条）；「会话复活」那行现在由 `test/guards.mjs` 的「38 崩溃 / 重启后同一会话接着算」一组用真实的「注销 → 同 id 复活」跑到（断言那行 info 真的落进诊断日志），所以上面给的是文案模板级证据，不是一次真崩溃抓下来的实样。

## 卸载

最省事的办法是在 DSH 的「设置 → 插件市场 → 已安装」里把它关掉（要重启一次才生效，原因见上面那节）。要连文件一起清干净：脚本**默认什么都不删**，只摘插件；只有显式给 `-PurgeState` / `-PurgeLog` 才分别删账本存档与诊断日志。删除口径已覆盖分片存档 `~/.dsh/loop-guard-state.<profile>.json`、旧路径 `~/.dsh/loop-guard-state.json`、一次性迁移残留 `loop-guard-state.json.migrated` 与写盘临时文件；日志连轮转文件 `loop-guard.log.1` 一起。`-KeepSource` 保留源码目录：

```powershell
pwsh -File "$HOME\.dsh\local-plugins\dsh-loop-guard\uninstall.ps1"                        # 只摘插件，什么都不删
pwsh -File "$HOME\.dsh\local-plugins\dsh-loop-guard\uninstall.ps1" -PurgeState -PurgeLog   # 连存档和日志一起删
```

然后完全退出 DSH 再打开。备份在 `~/.dsh/profiles/<profile>/.loop-guard-backup\`（`desktop` 只是默认示例，不是写死的路径：`uninstall.ps1` 的 `$profileDir` 由 `-ProfileDir` → `profiles\desktop` → 自动探测决定）。

改 `package.json` 之前，脚本**每次都另存一份带时间戳的** `package.json.<yyyyMMdd-HHmmss>.bak`（同一秒里跑两次会自动加序号，不会互相覆盖），并打印这次用的是哪一份；另外维护一份 `package.json.bak`（卸载**前**的状态）和一份 `package.json.after-uninstall.bak`（卸载**后**的状态），三者内容不同就刷新，并说明各自是哪一刻的快照。写回时只删目标键、保留原格式（2 空格缩进、原行尾、原编码），写完还会重新解析一遍并断言 `name` / `dsh.profile.bundles` 还在、`dsh-loop-guard` 已经不在了 —— 整个 `ConvertTo-Json` 重写会把格式和字段顺序一起改掉，那是份不属于它的改动。

手工恢复时用哪份：想撤销这次卸载 → `package.json.<时间戳>.bak`（或 `package.json.bak`）；想回到已经卸载好的状态 → `package.json.after-uninstall.bak`。

## 已知边界

- **设置面板只在装好之后才有。** schema 走 `createRequire('@deepseek-ai/schemastery')`，从源码目录直接跑测试时解析不到，这时 `Config` 是 `undefined` —— 插件照常工作，只是没有图形界面。装进 profile 之后就有了（实测：安装副本 `Config=function`，源码目录 `Config=undefined`）。有面板也仍然**环境变量优先**。
- **同一个会话 id 被复用给一段全新对话时，计数会被继承。** 崩溃 / 重启后的复活恢复是**按键取值**的：宿主只要把同一个 id 交给一段新对话，这段新对话就带着上一段留下的 13 项计数（有 parked 快照时还带着 4 项门的记忆）接着算（`disposed` 里的老会话、仍活着的会话都按同一条规则恢复）。会偏严 —— 新对话一开始就背着旧账、更容易撞上会话 / 家族预算门，但**不会漏算**。这是「直接恢复计数、不重放历史」换来的取舍：重放能把 id 复用认出来，却会把历史算第二遍。清法见上面「逃生门的计数跟着注销快照落盘，不跟着硬崩溃落盘」那条：删掉存档里该会话的记录，或把对应上限调高 / 设成 `0`（都要重启一次才生效）。
- **横向异常只比子代理，不比顶层会话。**
- **祖先链与扇出深度都有上限。** 往上追祖先最多 16 层（`hops < 16`），workflow 扇出只在 8 层以内往下走（`depth < 8`）—— 再深的树会被截断，算不到的那部分宁可漏报。`estimateAgents` 的乘数上限 1000。
- **workflow 的扇出是估算的**：脚本里出现「按条目逐个跑」的形状（`pipeline` / `parallel` / `for … of args.<键>`）且这次调用里那个键是数组时，就拿数组长度当乘数（上限 1000）；读不到就算 1，宁可漏报不误杀。字符串字面量与注释先被剥掉，所以 URL 里的 `//` 不会把同一行后面真正的 `agent()` 一起吃掉。
- **纯输出门**：**自本轮最后一次真的执行过工具调用以来**又累计吐够 `DSH_LOOP_GUARD_PURE_TALK_TOKENS`（默认 `200000`，病态量级）输出 token，才算「纯输出烧钱」，这时停止生成并提醒交账（`DSH_LOOP_GUARD_PURE_TALK_GUARD=0` 只关动作、计数照旧，阈值设 `0` 或负数才整道关掉）。旧判据是「本轮一次工具调用都没有、却输出到量」，先随便调一次工具再整轮狂喷输出就能绕过去，所以换成现在这个口径。它挂的是宿主的 `agent/pre-step` —— 宿主真的走到那个口子它才看得见，纯输出本身它自己数不出来；「距上次工具调用以来的输出量」这个游标**不落盘**，重启 / 复活后从 0 起算（只会更严，不会放松）。
- 账本里的计数表有上限（`SIGNATURE_CAP` / `CALLNAME_CAP` = 400、`ERROR_CAP` = 40、`ESCAPE_CAP` = 400、`RETIRED_CAP` = 2000，写盘另只留花得最多的 200 个会话）。满了**按插入顺序淘汰最旧的一条（FIFO）**，不再整体清空 —— 整体清空会把「已连拦几次」的逃生计数一起归零，那正是永久锁死的成因。逃生计数另存一张按签名散列的表（`ESCAPE_CAP`），满了只在**同前缀下别的**签名里淘汰最旧的一条 —— **绝不淘汰本次要用的那个 key**（同前缀下没有别的候选就不淘汰），并写一行 info 指名被淘汰的签名、说明本次 key 不受影响。`RETIRED_CAP`（2000）满了同样按插入顺序淘汰最旧一条（FIFO），而且**退休名单本身也落盘**（`retired`，随存档一起写、跨重启恢复）—— 重启后不会把已退休的会话当成新会话、把历史当成新账重放。
- **认不出工具名时会退回「不限定工具」。** callId → 工具名 的映射表只有 400 个名额，溢出按 FIFO 淘汰最旧的一条；要是一个很老的工具名被淘汰了，闸门就认不出是谁报的错，这时它会拦所有工具（老行为），而不是悄悄关掉自己不拦。失败载荷里的顶层 `name` 只在它不是 `ToolError` 这类错误类名时才采信。
- **逃生门的计数跟着注销快照落盘，不跟着硬崩溃落盘。** 「连拦 3 次就放行一次」的连拦计数与「首超一次」的配额豁免记录，都随 `session/disposed` 的 parked 快照写进存档，所以**注销 → 同 id 复活**之后接着数、不会白捡一次豁免；可宿主硬崩溃（没走到 `disposed`）时活着的会话只留下 13 项计数，门的记忆从零重新观察 —— 只会更严，不会放松。可 `totalInput` / `familyInput` 是从存档恢复的，所以**重启不会解除会话 / 家族预算** —— 它仍然在线上。真要手动解锁：删掉 `~/.dsh/loop-guard-state.<profile>.json` 里该会话那条记录，或把对应上限调高 / 设成 `0`（都要重启一次才生效）。
- **拒绝文案本身也消耗 token（首次完整版 / 后续一行短版）。** 插件拦下来时写进上下文的那句拒绝，是它自己产出的 token，所以「拦下来」不是免费的；短版是为了同一处反复拦时别再把上下文烧一遍。它靠 `DENY_MARK` 前缀（`【防烧钱`）+ **前 48 字符范围**认出自己写的文案并跳过，绝不把自己的拒绝文案计入账 —— 否则一拦就自增、越拦越像重复。
- **三张观察计数表不落盘。** 同签名 / 同骨架 / 同一个错误这三张表（`signatures` / `skeletons` / `errors`）只活在内存里，重启或复活之后从零重新观察；随会话落盘的只有 13 项计数与 4 项门的记忆。
- **插件内部异常时是 fail-open。** 记账、判门、写盘任何一步抛出异常，hook 都只让守卫打一次 warn / 变瞎，绝不让会话出错（见上面第二个原则）—— 这条路径上的调用不记账。`test/guards.mjs` 里 8 种畸形事件（`null` / 缺 `data` / `usage` 字段是字符串 / `turn` 是 `nope` 等）逐一喂进去都不抛，且之后的闸门照常工作。
- **测试里那条「真账本」断言在本机是退化的。** 它盯的是旧全局路径 `~/.dsh/loop-guard-state.json`，而本机活账本已按 profile 分文件，所以它断言的实际是「旧路径未被创建 / 改写」并打印一行 `SKIP`；换一台仍在用旧路径的机器才会真的比对存档字节。


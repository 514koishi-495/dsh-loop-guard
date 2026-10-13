# dsh-loop-guard · 防烧钱守卫

🔊 DSH 的一个本地插件。它不看内容、不调模型、不花一分钱，只做一件事：在工具调用真正发生之前，按几条纯算术的规则判断「这一步是不是又白烧钱」，是就拦下。

装好之后，一次问答的累计计费输入到 10 亿 token 会硬停手，同一条命令反复跑会拦，两种写法乒乓循环会拦，同一个错误反复出现会拦，子代理扇出失控会拦。

**它不由模型自觉，它由代码执行。** 这跟 `~/.dsh/skills/no-waste-loop-guard/` 那个技能是配套的：技能负责「我自觉」，插件负责「我赖不掉」。

## 万一它把你自己锁住了：怎么停手

守卫有可能自己出毛病（改判据改错了、账本算歪了），而修它本身又需要工具调用 —— 那就成了死循环。所以停手的路子必须**不需要模型参与**：

| 出口 | 怎么做 | 生效速度 |
|---|---|---|
| **插件市场里的启用开关**（首选） | 设置 → 插件市场 → 已安装 → 把这个插件的「启用中」关掉 | **下次启动**（见下） |
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

## 闸门一览

| 闸门 | 触发条件 | 默认值 | 拦截码 |
|---|---|---|---|
| 本轮预算 | 本轮问答的计费输入到线 | 1 亿 | `LOOP_GUARD_BUDGET_EXHAUSTED` |
| 会话总预算 | 整个会话跨轮累计到线 | 10 亿 | `LOOP_GUARD_SESSION_BUDGET` |
| 家族预算 | 自己 + 所有后代的累计到线 | 不设限 | `LOOP_GUARD_FAMILY_BUDGET` |
| 同签名重复 | 同工具同参数（命令会归一化）反复调 | 4 次（`read` 5 次） | `LOOP_GUARD_REPEAT` |
| 同骨架重复 | 只换数字/引号的同一件事。只对命令行生效；`read` 只折 `offset`/`limit`，路径原样保留；其余工具用精确签名 | 10 次 | `LOOP_GUARD_SKELETON` |
| 乒乓循环 | A B A B A B 整体在打转 | 3 轮 | `LOOP_GUARD_CYCLE` |
| 同一个错误 | 「工具名 + 归一化错误正文」这个指纹反复出现；**只拦报错的那个工具**，别的工具照常放行（不然连诊断用的读文件都会被堵死） | 2 次 | `LOOP_GUARD_SAME_ERROR` |
| 子代理请求数 | 单个子代理的模型请求数 | 80 | `LOOP_GUARD_SUBAGENT_REQUESTS` |
| 子代理工具数 | 单个子代理的工具调用数 | 150 | `LOOP_GUARD_SUBAGENT_TOOLS` |
| 横向异常 | 单个子代理每次请求的均值超过兄弟们的中位数 | 5 倍（至少 3 个兄弟） | `LOOP_GUARD_OUTLIER` |
| 空跑熔断 | 连着一个字都不返回还继续烧 | 3 次 | `LOOP_GUARD_BREAKER` |
| 扇出到顶 | 同时活着的子代理数 | 8 | `LOOP_GUARD_FANOUT` |
| workflow 扇出 | 脚本里 agent() 调用 × args 里的条目数 | 24 | `LOOP_GUARD_WORKFLOW_FANOUT` |
| 软着陆 | 到线后只拦贵的工具 | 关 | `LOOP_GUARD_SOFT_LANDING` |

「计费输入」= `inputTokens + cacheReadTokens + cacheWriteTokens`，也就是钱按这个数算；`inputTokens` 只是没命中缓存的那一份，光看它会严重低报。

### 「同一个错误」这条闸门到底认什么

这条闸门最容易帮倒忙，所以口径写清楚：

- **只有「同一个工具 + 同一个错误」才算。** 指纹是 `工具名 + 归一化错误正文`，A 工具的错误不会把 B 工具拦住。
- **插件自己的拒绝不算错误。** 拒绝载荷带 `error.name === 'LoopGuard'` / `error.code` 以 `LOOP_GUARD` 开头 / 正文里有 `【防烧钱`，一律跳过 —— 否则「被拦」会喂养「再拦」，而拒绝文本里嵌着上一次的拒绝文本，会一层套一层滚大。
- **瞬时 / 外部故障不算。** 网络层错误码、HTTP 方法后跟 URL、`429`、`500/502/503/504`、`rate limit`、`timed out` 都跳过：重试一次是合理的，不是原地打转。判据宁松勿严 —— 漏记一次只是少拦一次，误判一次就把人锁住。
- **报错的工具自己成功了，标志就放下。** 别的工具跑通不算（那不代表这个坑填上了）。
- 失败载荷两种形状都认：摊在事件顶层的 `name`/`code`/`reason`，以及收在 `data.error` 下面的那一份。

## 两个不许破的原则

1. **绝不把 agent 锁死。** 每一处拦截都带逃生门：同一处连拦 3 次之后一律放行一次，并且**放行时必须打 warn 日志**（静默放行等于偷偷烧钱）。
   逃生计数是**会话级**的、换轮不清零 —— 这条是用一次真实事故换来的：标志是粘性的、计数每轮归零，两个加起来就是永久锁死（详见 `CHANGELOG.md` 的 1.1.2）。
2. **记账失败不许拦住会话。** 事件字段对不上、磁盘写不进去，都只让守卫变瞎，不让会话出错。为了不变成「安静的哑巴」，跑了 20 次工具还收不到任何 usage 样本时会自己吼一声。

会话总预算的判定是「到线的那一轮放它走完」：模型要靠那一轮把交账报告写完（已经做完什么 / 还剩什么 / 建议你怎么继续），之后的新一轮才被否决。

## 永不拦的工具

`todo_write` `todo_read` `job_list` `job_output` `job_kill` `ask_user_question` `update_goal` `get_goal` `acp_status` `acp_cache` `search_context`

—— 这些要么是收尾、要么是跟人说话，拦了只会让它卡死。

## 环境变量

阈值不用改代码，改环境变量就行；技能里写的数字只是默认口径。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_LOOP_GUARD_MAX_TOKENS` | `100000000` | 本轮上限 |
| `DSH_LOOP_GUARD_SESSION_MAX_TOKENS` | `1000000000` | 会话累计上限；设 `0` = 不设限 |
| `DSH_LOOP_GUARD_FAMILY_MAX_TOKENS` | 不设限 | 家族上限；设 `0` = 不设限 |
| `DSH_LOOP_GUARD_WARN_RATIO` | `0.7` | 用到几成开始预警 |
| `DSH_LOOP_GUARD_REPEAT_LIMIT` | `4` | 同签名 |
| `DSH_LOOP_GUARD_READ_REPEAT_LIMIT` | `5` | 读文件单独放宽 |
| `DSH_LOOP_GUARD_SKELETON_LIMIT` | `10` | 同骨架 |
| `DSH_LOOP_GUARD_CYCLE_LIMIT` | `3` | 乒乓循环 |
| `DSH_LOOP_GUARD_SAME_ERROR_LIMIT` | `2` | 同一个错误 |
| `DSH_LOOP_GUARD_MAX_DENIALS` | `3` | 逃生门：连拦几次后放行 |
| `DSH_LOOP_GUARD_MAX_FANOUT` | `8` | 同时活着的子代理 |
| `DSH_LOOP_GUARD_FANOUT_TTL_MS` | `1200000` | 多久没动静算它已经死了 |
| `DSH_LOOP_GUARD_MAX_WORKFLOW_AGENTS` | `24` | workflow 内子代理 |
| `DSH_LOOP_GUARD_MAX_SUBAGENT_REQUESTS` | `80` | 子代理请求数 |
| `DSH_LOOP_GUARD_MAX_SUBAGENT_TOOLS` | `150` | 子代理工具数 |
| `DSH_LOOP_GUARD_OUTLIER_RATIO` | `5` | 横向异常倍数 |
| `DSH_LOOP_GUARD_OUTLIER_MIN_SIBLINGS` | `3` | 至少几个兄弟才比较 |
| `DSH_LOOP_GUARD_OUTLIER_FLOOR_TOKENS` | `5000000` | 太小不判异常 |
| `DSH_LOOP_GUARD_EMPTY_RESULT_TOKENS` | `20000000` | 熔断：花到多少还空手 |
| `DSH_LOOP_GUARD_EMPTY_RESULT_OUTPUT` | `500` | 熔断：输出少于多少字算空手 |
| `DSH_LOOP_GUARD_MAX_BATCH_FAILURES` | `3` | 熔断：连空几次 |
| `DSH_LOOP_GUARD_VETO_NEW_TURN` | `0` | 到线后否决新一轮（默认关：`agent/pre-step` 的 `reject` 是**空决定**，带不了任何解释，用户会被静默闷住，所以默认只拦工具、留一条「模型还能说话」的路） |
| `DSH_LOOP_GUARD_SOFT_LANDING` | `0` | 软着陆 |
| `DSH_LOOP_GUARD_NO_PERSIST` | — | 设 `1` = 不写盘 |
| `DSH_LOOP_GUARD_STATE_FILE` | `~/.dsh/loop-guard-state.json` | 存档路径 |
| `DSH_LOOP_GUARD_OFF` | — | 设 `1` = 整个插件不装任何钩子（**启动时**读，要重启；等价于面板里的 `off`） |

## 跨重启记账

「一次问答」很容易跨一次 DSH 重启。存档只写数字，不写任何对话内容：

```
{ "version": 1, "savedAt": "...", "sessions": { "<会话 id>": { "totalInput": 950000000, ... } } }
```

写盘是节流的（10 秒最多一次），只保留花得最多的 200 个会话。读盘失败一律当第一次跑。

## 测试

```powershell
$d = "$HOME\.dsh\local-plugins\dsh-loop-guard"
node "$d\test\smoke.mjs"            # 35 项：老闸门
node "$d\test\guards.mjs"           # 61 项：新闸门
node "$d\test\persist.mjs" write    # 5 项：写得进去
node "$d\test\persist.mjs" read     # 3 项：读得回来并据此拦人
```

测试全程不碰真账本（`DSH_LOOP_GUARD_STATE_FILE` 指向 `test/` 下的文件，并且默认 `NO_PERSIST`）。跨重启那一项必须分两个进程跑——账本是模块级的，一个进程里只能干净地测「写」或「读」。

## 卸载

最省事的办法是在 DSH 的「设置 → 插件市场 → 已安装」里把它关掉（要重启一次才生效，原因见上面那节）。要连文件一起清干净：

```powershell
pwsh -File "$HOME\.dsh\local-plugins\dsh-loop-guard\uninstall.ps1"
```

然后完全退出 DSH 再打开。备份在 `~/.dsh/profiles/desktop/.loop-guard-backup\`。

## 已知边界

- **设置面板只在装好之后才有。** schema 走 `createRequire('@deepseek-ai/schemastery')`，从源码目录直接跑测试时解析不到，这时 `Config` 是 `undefined` —— 插件照常工作，只是没有图形界面。装进 profile 之后就有了（实测：安装副本 `Config=function`，源码目录 `Config=undefined`）。有面板也仍然**环境变量优先**。
- **横向异常只比子代理，不比顶层会话。**
- **workflow 的扇出是估算的**：读不到 `args` 数组就按 1 算，宁可漏报不误杀。
- **插件不拦「模型一直在说话」**：它只挂工具调用和轮次两个口子，一次都不调工具的纯闲聊它管不着（那种情况由技能和自己看账负责）。
- 账本里的会话数有上限（`SIGNATURE_CAP`、`RETIRED_CAP`、`CALLNAME_CAP` 与写盘 top 200），超长跑很多会话时会淘汰最老的。`RETIRED_CAP` 被清空过一次的会话 id，理论上会被当成全新的会话重新放行一笔 —— 宁可漏算，也不要凭空多扣钱。
- **认不出工具名时会退回「不限定工具」。** callId → 工具名 的映射表只有 400 个名额，溢出会整体清空；这时闸门认不出是谁报的错，就会拦所有工具（老行为），而不是悄悄关掉自己不拦。失败载荷里的顶层 `name` 只在它不是 `ToolError` 这类错误类名时才采信。
- **逃生门的计数不落盘。**「连拦 3 次就放行一次」的计数只活在内存里，DSH 一重启就归零。这是故意的：万一闸门本身出了问题，重启就是最后一道手动解锁。


# 卸载 dsh-loop-guard
#
# 完全退出 DSH 之后再跑这个。它会：
#
#   1. 从 profile 的 package.json 里摘掉 dsh.profile.bundles 里的 dsh-loop-guard
#   2. 摘掉 dependencies 里的 file: 条目
#   3. 删掉 node_modules\dsh-loop-guard
#   4. **默认不动**账本存档（~\.dsh\loop-guard-state.json）与诊断日志（~\.dsh\loop-guard.log）
#      —— 这两个文件在 ~\.dsh 下，是**所有 profile 共用**的：在 desktop 上卸载顺手删掉它们，
#      会连别的 profile 的账本与历史日志一起清掉。要删得显式说 -PurgeState / -PurgeLog，
#      而且删之前会先备份进 .loop-guard-backup\files-<时间戳>\。
#
# 备份目录 .loop-guard-backup\ 里，每次卸载都会留一份带时间戳的
# package.json.<yyyyMMdd-HHmmss>.bak（**本次**卸载前的状态），另外维护一份
# package.json.bak = 最近一次卸载前的状态。脚本会把这次用的是哪一份打出来。
# pnpm-lock.yaml.bak / pnpm-workspace.yaml.bak 是你不想手动摘的时候的退路，脚本不动它们。
#
# package.json **不做整文件重写**：只删目标那两行，别的字节一个都不动，写完再解析一遍自检；
# 自检不过就从备份还原并报错退出。
#
# 用法（注意：★ 下面这整段说明以前是裸文本，PowerShell 根本解析不了这个脚本 ——
# 现在全部收进注释里，param() 之前的每一行都以 # 开头）：
#
#   pwsh -File "$env:USERPROFILE\.dsh\local-plugins\dsh-loop-guard\uninstall.ps1"
#
# 参数：
#   -ProfileDir <路径>  指定 profile 目录；不给就先用 profiles\desktop，再自动探测
#                       （profiles\* 里 package.json 提到 dsh-loop-guard 的那个）
#   -PurgeState   连账本存档一起清掉（删前备份）
#   -PurgeLog     连诊断日志一起清掉（删前备份）
#   -KeepState    保留账本存档（这是默认行为，保留只为兼容旧命令）
#   -KeepLog      保留诊断日志（同上）
#   -KeepSource   不提示源码目录还在（只是少打一行字）

param(

	[switch]$KeepState,
	[switch]$KeepLog,
	[switch]$KeepSource,
	[switch]$PurgeState,
	[switch]$PurgeLog,
	[string]$ProfileDir
)

$ErrorActionPreference = 'Stop'

# profile 目录：-ProfileDir 优先 → profiles\desktop → 自动探测装了本插件的 profile。
# 以前把 desktop 写死，换个 profile 名字就直接 throw（多 profile / 重命名的用户用不了）。
$profilesRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
if ($ProfileDir) {
	$profileDir = $ProfileDir
} else {
	$desktopDir = Join-Path $profilesRoot 'desktop'
	if (Test-Path (Join-Path $desktopDir 'package.json')) {
		$profileDir = $desktopDir
	} else {
		$candidates = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
				$p = Join-Path $_.FullName 'package.json'
				(Test-Path $p) -and ((Get-Content $p -Raw -Encoding UTF8) -match 'dsh-loop-guard')
			})
		if ($candidates.Count -eq 1) {
			$profileDir = $candidates[0].FullName
			Write-Host "自动探测到 profile：$profileDir"
		} elseif ($candidates.Count -eq 0) {
			throw "没找到装了 dsh-loop-guard 的 profile，请用 -ProfileDir 指定（找过：$profilesRoot）"
		} else {
			throw "有多个 profile 装了 dsh-loop-guard，请用 -ProfileDir 指定其中一个：$($candidates.FullName -join ' , ')"
		}
	}
}

$pkgPath = Join-Path $profileDir 'package.json'
$pluginDir = Join-Path $profileDir 'node_modules\dsh-loop-guard'
$statePath = Join-Path $env:USERPROFILE '.dsh\loop-guard-state.json'
$logPath = Join-Path $env:USERPROFILE '.dsh\loop-guard.log'

if (-not (Test-Path $pkgPath)) { throw "找不到 profile 的 package.json：$pkgPath" }

# ────────────────────────────── 备份 ──────────────────────────────
#
# 以前是「备份目录存在就跳过备份」。那是个陷阱：目录里躺着的是**上一次**卸载前的
# 内容，第二次卸载既不刷新它、也不说它有多旧 —— 等于拿一份过期的还原点去改一个
# 早就变过的文件，甚至「没有备份可用」。现在每次都留一份带时间戳的，并明确说清
# 用的是哪一份。
$backup = Join-Path $profileDir '.loop-guard-backup'
if (-not (Test-Path $backup)) { New-Item -ItemType Directory -Path $backup | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stampedBackup = Join-Path $backup "package.json.$stamp.bak"
# 同一秒里跑两次（比如脚本里连着调）不能互相覆盖 —— 否则「每次留一份」又变成空话。
$serial = 2
while (Test-Path $stampedBackup) {
	$stampedBackup = Join-Path $backup "package.json.$stamp-$serial.bak"
	$serial += 1
}
Copy-Item $pkgPath $stampedBackup -Force
Write-Host "已备份 package.json → $stampedBackup"

# 「最新的那一份」也维护着，但内容相同就不重复刷新 —— 免得把一个本来有意义的
# 还原点盖成一堆一模一样的副本。
$latestBackup = Join-Path $backup 'package.json.bak'
$sameAsLatest = (Test-Path $latestBackup) -and
	((Get-FileHash $latestBackup -Algorithm SHA256).Hash -eq (Get-FileHash $stampedBackup -Algorithm SHA256).Hash)
if ($sameAsLatest) {
	Write-Host "（$latestBackup 与本次内容相同，未刷新：它已经是本次卸载前的状态）"
} else {
	Copy-Item $pkgPath $latestBackup -Force
	Write-Host "（已刷新 $latestBackup = 本次卸载前的状态）"
}

# ────────────────────── 只摘掉两处登记，别的字节不动 ──────────────────────
#
# 以前用整文件 ConvertTo-Json 重写：字段顺序、缩进、转义都可能被动过，diff 里全是噪声，
# 还可能把 name 之类的字段转义掉。现在直接对原文做最小的文本手术：只删掉目标那一行；
# 若它正好是数组/对象的最后一项，再把上一行留下的悬空逗号一起摘掉。
$original = Get-Content $pkgPath -Raw -Encoding UTF8
$beforePkg = $original | ConvertFrom-Json   # 原文必须先能解析，否则不动它
$hadBundle = @($beforePkg.dsh.profile.bundles) -contains 'dsh-loop-guard'
$hadDep = $beforePkg.dependencies.PSObject.Properties.Name -contains 'dsh-loop-guard'
$beforeBundleCount = @($beforePkg.dsh.profile.bundles).Count
$beforeDepCount = @($beforePkg.dependencies.PSObject.Properties).Count

function script:Remove-EntryLine([string]$text, [string]$pattern) {
	$m = [regex]::Match($text, $pattern)
	if (-not $m.Success) { return $text }
	$out = $text.Remove($m.Index, $m.Length)
	if (-not $m.Groups['comma'].Success) {
		# 摘掉的正好是数组/对象的最后一项：上一行还留着一个逗号，一起摘掉
		$dangling = [regex]::Match($out, ',(?=[ \t]*\r?\n[ \t]*[\]\}])')
		if ($dangling.Success) { $out = $out.Remove($dangling.Index, 1) }
	}
	return $out
}

$text = $original
$text = Remove-EntryLine $text '(?m)^[ \t]*"dsh-loop-guard"[ \t]*(?<comma>,[ \t]*)?\r?\n'
$text = Remove-EntryLine $text '(?m)^[ \t]*"dsh-loop-guard"[ \t]*:[ \t]*"[^"]*"[ \t]*(?<comma>,[ \t]*)?\r?\n'

if ($text -eq $original) {
	Write-Host 'package.json 里本来就没有 dsh-loop-guard 的登记，未改动它'
} else {
	# ── 写完自检：解析得回来、关键字段还在、只有目标那两行被删 ──
	$problems = @()
	$parsed = $null
	try { $parsed = $text | ConvertFrom-Json } catch { $problems += "改写后的 JSON 解析不了：$($_.Exception.Message)" }

	if ($null -ne $parsed) {
		if ($parsed.name -ne $beforePkg.name) { $problems += "name 字段被改了：$($beforePkg.name) → $($parsed.name)" }
		if (@($parsed.dsh.profile.bundles) -contains 'dsh-loop-guard') { $problems += 'bundles 里还有 dsh-loop-guard' }
		if ($parsed.dependencies.PSObject.Properties.Name -contains 'dsh-loop-guard') { $problems += 'dependencies 里还有 dsh-loop-guard' }
		$expectBundles = if ($hadBundle) { $beforeBundleCount - 1 } else { $beforeBundleCount }
		$expectDeps = if ($hadDep) { $beforeDepCount - 1 } else { $beforeDepCount }
		if (@($parsed.dsh.profile.bundles).Count -ne $expectBundles) {
			$problems += "bundles 条数不对：$beforeBundleCount → $(@($parsed.dsh.profile.bundles).Count)（预期 $expectBundles）"
		}
		if (@($parsed.dependencies.PSObject.Properties).Count -ne $expectDeps) {
			$problems += "dependencies 条数不对：$beforeDepCount → $(@($parsed.dependencies.PSObject.Properties).Count)（预期 $expectDeps）"
		}
		if (-not (@($parsed.dsh.profile.bundles) -contains '@deepseek-ai/dsh-base')) { $problems += '别的 bundle 条目被误删了' }
	}

	$diff = @(Compare-Object -ReferenceObject @($original -split '\r?\n') -DifferenceObject @($text -split '\r?\n') -PassThru)
	$removedLines = @($diff | Where-Object { $_.SideIndicator -eq '<=' } | ForEach-Object { [string]$_ })
	$addedLines = @($diff | Where-Object { $_.SideIndicator -eq '=>' } | ForEach-Object { [string]$_ })
	# 被摘项正好在数组/对象末尾时，上一行的悬空逗号也要摘掉 —— 每处末尾各产生 1 行改动。
	# 以前一律只允许 1 行：插件同时是 bundles 与 dependencies 的最后一项时（两处都要修逗号）
	# 会把自己判成「多了 2 行改动」，回滚 + 退出码 1，卸载根本做不完。
	$bundleWasLast = $hadBundle -and (@($beforePkg.dsh.profile.bundles)[-1] -eq 'dsh-loop-guard')
	$depNames = @($beforePkg.dependencies.PSObject.Properties.Name)
	$depWasLast = $hadDep -and ($depNames.Count -gt 0) -and ($depNames[-1] -eq 'dsh-loop-guard')
	$maxAddedLines = [int]$bundleWasLast + [int]$depWasLast
	if ($addedLines.Count -gt $maxAddedLines) { $problems += "多了 $($addedLines.Count) 行改动（只允许 $maxAddedLines 行：两处末尾各要去掉一个悬空逗号）" }
	foreach ($line in $removedLines) {
		$trimmed = $line -replace ',\s*$', ''
		$isCommaLine = @($addedLines | Where-Object { $_ -eq $trimmed }).Count -gt 0
		if ($line -notmatch 'dsh-loop-guard' -and -not $isCommaLine) { $problems += "动到了不该动的行：$line" }
	}

	if ($problems.Count -gt 0) {
		Copy-Item $stampedBackup $pkgPath -Force
		throw "package.json 自检没过，已从 $stampedBackup 还原：`n - $($problems -join "`n - ")"
	}

	[System.IO.File]::WriteAllText($pkgPath, $text, (New-Object System.Text.UTF8Encoding($false)))
	Write-Host "已从 package.json 摘掉 dsh-loop-guard（删了 $($removedLines.Count) 行、改了 $($addedLines.Count) 行，其余字节未动）"
}

# ────────────────────────────── 清文件 ──────────────────────────────

if (Test-Path $pluginDir) {
	Remove-Item $pluginDir -Recurse -Force
	Write-Host "已删掉 $pluginDir"
} else {
	Write-Host "node_modules 里本来就没有 dsh-loop-guard"
}

# ── 账本与日志：默认不动 ──
#
# 这两个文件在 ~\.dsh 下，是**所有 profile 共用**的（谁在跑谁就往里写）。以前默认删掉它们，
# 等于在 desktop 上卸载会顺手清掉别的 profile 的账本与历史日志，而且删了不留备份。
# 现在默认留着；要删得显式说 -PurgeState / -PurgeLog，删之前先备份进 .loop-guard-backup\。
if ($KeepState -or $KeepLog) {
	Write-Host '（-KeepState / -KeepLog 现在就是默认行为，可以省掉：这两个文件默认不删）'
}
$purgeTargets = @()
if ($PurgeState -and (Test-Path $statePath)) { $purgeTargets += $statePath }
if ($PurgeLog -and (Test-Path $logPath)) { $purgeTargets += $logPath }
if ($purgeTargets.Count -gt 0) {
	$fileBackup = Join-Path $backup "files-$stamp"
	if (-not (Test-Path $fileBackup)) { New-Item -ItemType Directory -Path $fileBackup | Out-Null }
	foreach ($target in $purgeTargets) {
		Copy-Item $target (Join-Path $fileBackup (Split-Path $target -Leaf)) -Force
		Remove-Item $target -Force
		Write-Host "已删掉 $target（删前已备份到 $fileBackup）"
	}
} else {
	$leftAlone = @($statePath, $logPath) | Where-Object { Test-Path $_ }
	if ($leftAlone.Count -gt 0) {
		Write-Host "账本与日志留着了（在 ~\.dsh 下，所有 profile 共用）：$($leftAlone -join '、')"
		Write-Host '要连它们一起清掉，加 -PurgeState -PurgeLog（删前会先备份到 .loop-guard-backup\）。'
	}
}

if (-not $KeepSource) {
	$src = Join-Path $env:USERPROFILE '.dsh\local-plugins\dsh-loop-guard'
	if (Test-Path $src) { Write-Host "源码目录还在（没动它）：$src" }
}

Write-Host ''
Write-Host '**现在请完全退出 DSH 再打开。**'

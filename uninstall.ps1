# 卸载 dsh-loop-guard

完全退出 DSH 之后再跑这个。它会：

1. 从 profile 的 `package.json` 里摘掉 `dsh.profile.bundles` 里的 `dsh-loop-guard`
2. 摘掉 `dependencies` 里的 `file:` 条目
3. 删掉 `node_modules\dsh-loop-guard`
4. 删掉账本存档（默认 `~\.dsh\loop-guard-state.json`）

备份目录 `.loop-guard-backup\` 里的 `package.json.bak` / `pnpm-lock.yaml.bak` / `pnpm-workspace.yaml.bak` 是你不想手动摘的时候的退路，脚本不动它。

```powershell
pwsh -File "$env:USERPROFILE\.dsh\local-plugins\dsh-loop-guard\uninstall.ps1"
```

参数：

- `-KeepState` 保留账本存档
- `-KeepSource` 不提示源码目录还在（只是少打一行字）

```powershell
param(
	[switch]$KeepState,
	[switch]$KeepSource
)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pkgPath = Join-Path $profileDir 'package.json'
$pluginDir = Join-Path $profileDir 'node_modules\dsh-loop-guard'
$statePath = Join-Path $env:USERPROFILE '.dsh\loop-guard-state.json'

if (-not (Test-Path $pkgPath)) { throw "找不到 profile 的 package.json：$pkgPath" }

$backup = Join-Path $profileDir '.loop-guard-backup'
if (-not (Test-Path $backup)) {
	New-Item -ItemType Directory -Path $backup | Out-Null
	Copy-Item $pkgPath (Join-Path $backup 'package.json.bak') -Force
	Write-Host "已备份 package.json 到 $backup"
}

$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-loop-guard' })
if ($pkg.dependencies.PSObject.Properties.Name -contains 'dsh-loop-guard') {
	$pkg.dependencies.PSObject.Properties.Remove('dsh-loop-guard')
}
$json = $pkg | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '已从 package.json 摘掉 dsh-loop-guard'

if (Test-Path $pluginDir) {
	Remove-Item $pluginDir -Recurse -Force
	Write-Host "已删掉 $pluginDir"
} else {
	Write-Host "node_modules 里本来就没有 dsh-loop-guard"
}

if (-not $KeepState -and (Test-Path $statePath)) {
	Remove-Item $statePath -Force
	Write-Host "已删掉账本存档 $statePath"
}

if (-not $KeepSource) {
	$src = Join-Path $env:USERPROFILE '.dsh\local-plugins\dsh-loop-guard'
	if (Test-Path $src) { Write-Host "源码目录还在（没动它）：$src" }
}

Write-Host ''
Write-Host '**现在请完全退出 DSH 再打开。**'

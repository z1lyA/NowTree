# 1.1.7：生成 tauri-plugin-updater 用的 latest.json。
#
# 为什么需要它：updater 的更新源是一个「静态 JSON 清单」，里面写清新版本号、
# 安装包下载地址、以及安装包的 .sig 签名内容（注意是签名文本，不是路径）。
# 应用启动检查更新时，会拉取 tauri.conf.json 里 endpoints 指向的这个文件。
#
# 用法：
#   1) 先跑 scripts\build-release.bat（产出安装包 + .sig）
#   2) 再跑本脚本：      powershell -ExecutionPolicy Bypass -File scripts\make-latest-json.ps1
#   3) 把 src-tauri\target\release\bundle\latest.json 作为 Release 附件上传
#      （和 setup.exe / .msi 一起传，endpoints 用的是 releases/latest/download/latest.json）
#
# 依赖约定：
#   - 版本号唯一来源是 src-tauri/tauri.conf.json 的 version，本脚本不另立一处。
#   - 签名文件必须是构建时用私钥生成的 .sig；没有 .sig 说明构建时没设
#     TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PATH，或 createUpdaterArtifacts 不是 true。
#
# 两个编码坑（都踩过）：
#   - 本文件必须存成「UTF-8 带 BOM」，否则 PS 5.1 按 GBK 解析中文注释会报字符串未闭合。
#   - 生成的 latest.json 必须「UTF-8 不带 BOM」，否则 Tauri 解析报 expected value at line 1 column 1。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$confPath = Join-Path $root 'src-tauri\tauri.conf.json'
$conf = Get-Content $confPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $conf.version

$bundleDir = Join-Path $root 'src-tauri\target\release\bundle'
$setup = Join-Path $bundleDir "nsis\NowTree_${version}_x64-setup.exe"
$sigPath = "$setup.sig"

if (-not (Test-Path $setup)) {
    throw "找不到安装包：$setup`n请先运行 scripts\build-release.bat"
}
if (-not (Test-Path $sigPath)) {
    throw "找不到签名文件：$sigPath`n请确认构建时设置了 TAURI_SIGNING_PRIVATE_KEY_PATH，且 createUpdaterArtifacts = true"
}

# 发布说明：取 Release notes 的前几行，去掉 markdown 记号后压成纯文本。
# 必须显式 -Encoding UTF8：PS 5.1 的默认编码是 ANSI，读 UTF-8 的 md 会整段乱码。
# updater 弹窗只显示 8 行，塞整篇会撑爆弹窗，所以这里限行 + 限长。
$notes = ''
$notesFile = Join-Path $root "Materials\release_notes\RELEASE_NOTES_v$version.md"
if (Test-Path $notesFile) {
    $lines = Get-Content $notesFile -Encoding UTF8 |
        ForEach-Object { ($_ -replace '\*\*', '') -replace '^\s*[#>*\-]+\s*', '' } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne '' } |
        Select-Object -First 8
    $notes = $lines -join "`n"
    if ($notes.Length -gt 420) {
        $notes = $notes.Substring(0, 420) + '…'
    }
}

# 下载地址必须与 Release 附件名**完全一致**（AGENTS.md 的发布流程用的是这个文件名）。
$assetName = "NowTree_${version}_x64-setup.exe"
$url = "https://github.com/z1lyA/NowTree/releases/download/v$version/$assetName"

$signature = (Get-Content $sigPath -Raw -Encoding UTF8).Trim()

$manifest = [ordered]@{
    version   = $version
    notes     = $notes
    pub_date  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url       = $url
        }
    }
}

$json = $manifest | ConvertTo-Json -Depth 5
$out = Join-Path $bundleDir 'latest.json'
[IO.File]::WriteAllText($out, $json, (New-Object Text.UTF8Encoding($false)))  # $false = 不写 BOM

Write-Host "[NowTree] latest.json 已生成：$out"
Write-Host "[NowTree]   version  : $version"
Write-Host "[NowTree]   url      : $url"
Write-Host "[NowTree]   signature: $($signature.Substring(0, [Math]::Min(24, $signature.Length)))..."
Write-Host "[NowTree] 记得把 latest.json 一起传到 Release 附件。"

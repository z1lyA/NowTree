@echo off
setlocal

REM === NowTree release build (produces installable package) ===
REM Sets non-standard MSVC / Windows SDK paths, then runs: npm run tauri build
REM Place this file in the scripts/ folder and double-click it.
REM Output: src-tauri\target\release\bundle\  (the .msi / .exe installer)

set "MSVC_BIN=H:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64"
set "CARGO_BIN=C:\Users\zJJ\.cargo\bin"

set "SDK_INC=D:\Windows Kits\10\Include\10.0.28000.0"
set "SDK_LIB=D:\Windows Kits\10\Lib\10.0.28000.0"
set "MSVC_INC=H:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\include"
set "MSVC_LIB=H:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\lib\x64"

set "PATH=%MSVC_BIN%;%CARGO_BIN%;%PATH%"
set "INCLUDE=%SDK_INC%\um;%SDK_INC%\shared;%SDK_INC%\ucrt;%MSVC_INC%"
set "LIB=%SDK_LIB%\um\x64;%SDK_LIB%\ucrt\x64;%MSVC_LIB%"

cd /d "%~dp0.."

REM 仅在 source.png 相对上次提交有变动时才重生成图标，
REM 避免每次打包都触发 tauri icon 导致 icon.icns 产生无意义的字节伪差异（见 git 历史）。
set "SRC=src-tauri\icons\source.png"
if exist "%SRC%" (
    for /f "delims=" %%h in ('git hash-object "%SRC%"') do set "CUR_HASH=%%h"
    set "BASE_HASH="
    for /f "delims=" %%b in ('git rev-parse "HEAD:src-tauri/icons/source.png" 2^>nul') do set "BASE_HASH=%%b"
    if not "%CUR_HASH%"=="%BASE_HASH%" (
        echo [NowTree] 检测到 source.png 变动，重新生成图标...
        call npm run tauri icon -- "%SRC%"
    ) else (
        echo [NowTree] source.png 未变动，跳过图标重生成。
    )
) else (
    echo [NowTree] WARNING: source.png not found, using existing icons
)

echo [NowTree] building release package (this takes a few minutes)...
call npm run tauri build
echo [NowTree] done. Installer is in src-tauri\target\release\bundle\

endlocal

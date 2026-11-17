@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title 煤矿排水设备故障风险预警平台

echo ==============================================
echo   煤矿排水设备故障风险预警平台 - Windows启动
echo ==============================================
echo.

REM 优先使用 Python 3.12，其次尝试 Python 3.13
set "PYTHON_CMD="
where py >nul 2>nul
if %errorlevel%==0 (
    py -3.12 --version >nul 2>nul
    if not errorlevel 1 set "PYTHON_CMD=py -3.12"
    if not defined PYTHON_CMD (
        py -3.13 --version >nul 2>nul
        if not errorlevel 1 set "PYTHON_CMD=py -3.13"
    )
)

if not defined PYTHON_CMD (
    where python >nul 2>nul
    if not errorlevel 1 (
        python --version
        set "PYTHON_CMD=python"
    )
)

if not defined PYTHON_CMD (
    echo [错误] 未检测到 Python 3.12 或 3.13。
    echo 请先安装 Python 3.12/3.13，并勾选 Add Python to PATH。
    echo 下载地址：https://www.python.org/downloads/windows/
    pause
    exit /b 1
)

echo 使用解释器：%PYTHON_CMD%
%PYTHON_CMD% --version
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] 正在创建虚拟环境...
    %PYTHON_CMD% -m venv .venv
    if errorlevel 1 goto :error
) else (
    echo [1/3] 虚拟环境已存在。
)

echo.
echo [2/3] 正在检查并安装依赖（首次运行需要联网）...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :error
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto :error

echo.
echo [3/3] 正在启动服务...
echo 浏览器将自动打开 http://127.0.0.1:8770
echo 关闭本窗口或按 Ctrl+C 可停止服务。
echo.
".venv\Scripts\python.exe" dashboard.py --port 8770
if errorlevel 1 (
    echo.
    echo [错误] 程序退出时发生错误，请查看上方报错信息。
    pause
)
exit /b 0

:error
echo.
echo [错误] 环境创建或依赖安装失败。
echo 请检查网络、Python安装情况及上方报错信息。
pause
exit /b 1

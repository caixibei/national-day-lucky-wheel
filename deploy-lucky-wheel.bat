@echo off
REM ============================================
REM  国庆大转盘 · 前端静态同步脚本
REM  将项目 public/ 镜像同步到 nginx 的 html/lucky-wheel/
REM  改完前端代码后双击运行即可，无需重启 Node 服务
REM ============================================
chcp 65001 >nul
cd /d %~dp0

echo [1/2] 同步 public/ -^> D:\protable\nginx-1.31.4\html\lucky-wheel\
robocopy public "D:\protable\nginx-1.31.4\html\lucky-wheel" /MIR /NFL /NDL /NJH /NJS /NP

REM robocopy 退出码 0-7 均为成功（含"有新文件复制"），8 及以上为失败
if %errorlevel% lss 8 (
    echo [2/2] 同步完成，浏览器强制刷新（Ctrl+F5）即可看到最新页面。
) else (
    echo [FAIL] 同步失败，robocopy 退出码 %errorlevel%，请检查路径与权限。
)
pause

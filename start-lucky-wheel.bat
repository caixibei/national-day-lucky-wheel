@echo off
chcp 65001 >nul
title 国庆大转盘 · pm2 管理

echo [1/2] 通过 pm2 重启大转盘服务...
pm2 restart lucky-wheel

echo.
echo [2/2] 当前进程状态：
pm2 list

echo.
echo 常用命令：
echo   pm2 logs lucky-wheel          查看日志
echo   pm2 stop lucky-wheel          停止服务
echo   pm2 restart lucky-wheel       重启服务（改 .env/后端代码后执行）
echo   前端页面改动后运行 deploy-lucky-wheel.bat 同步静态，无需重启
pause

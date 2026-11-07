@echo off
rem 三张 · 水墨自观察 —— 起服务并打开浏览器
cd /d "%~dp0"
start "" http://localhost:8787
node server\server.mjs
pause

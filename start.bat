@echo off
cd /d "%~dp0"
start http://localhost:3900
node server.js

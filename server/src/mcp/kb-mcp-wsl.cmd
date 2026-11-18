@echo off
setlocal DisableDelayedExpansion
if not defined FEISHU_SYNC_BRIDGE_APP exit /b 1
if not defined FEISHU_SYNC_BRIDGE_BUNDLE exit /b 1
if not defined FEISHU_SYNC_BRIDGE_HOME exit /b 1
set "ELECTRON_RUN_AS_NODE=1"
"%FEISHU_SYNC_BRIDGE_APP%" "%FEISHU_SYNC_BRIDGE_BUNDLE%"
exit /b %ERRORLEVEL%

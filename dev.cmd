@echo off
rem ---------------------------------------------------------------------------
rem  Double-click launcher for the dev server.
rem
rem  Why this exists: the server used to be started from the Claude Code preview
rem  pane, which was convenient but tied its lifetime to that tool — when the
rem  harness cleaned the preview up, Chrome lost its backend mid-session, twice.
rem  Testing happens in Chrome (the embedded browser does not show the native
rem  alert/confirm dialogs, so the WRITE path cannot be exercised there), so the
rem  server has to outlive whatever else is running.
rem
rem  The window stays open after the server exits, on purpose: both unexplained
rem  deaths left nothing behind to read. Whatever it prints on the way out is the
rem  evidence.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
title MSS54HP dev server  -  http://127.0.0.1:5054
echo Starting the dev server on http://127.0.0.1:5054
echo Leave this window open. Closing it stops the server.
echo.
call npm run dev
echo.
echo ===========================================================================
echo  The dev server has exited. The reason, if any, is printed above.
echo ===========================================================================
pause

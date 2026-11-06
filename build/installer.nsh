!macro customCheckAppRunning
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    InitPluginsDir
    File /oname=$PLUGINSDIR\close-feishu-sync.ps1 "${BUILD_RESOURCES_DIR}\close-feishu-sync.ps1"

    # The desktop updater has already requested a graceful shutdown. Manual
    # setup still asks before closing an active desktop or MCP session.
    ${ifNot} ${isUpdated}
      nsExec::Exec /TIMEOUT=10000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-feishu-sync.ps1" -Executable "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -CheckOnly`
      Pop $R0
      ${if} $R0 == 0
        Goto feishuCloseDone
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK feishuCloseRetry
      Quit
    ${endIf}

    feishuCloseRetry:
      DetailPrint "$(appClosing)"
      nsExec::ExecToLog /TIMEOUT=20000 `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\close-feishu-sync.ps1" -Executable "$INSTDIR\${APP_EXECUTABLE_FILENAME}"`
      Pop $R0
      ${if} $R0 != 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY feishuCloseRetry
        SetErrorLevel 1
        Quit
      ${endIf}
    feishuCloseDone:
  ${endIf}
!macroend

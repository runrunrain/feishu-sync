param(
    [Parameter(Mandatory = $true)][string] $Executable,
    [switch] $CheckOnly
)

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($Executable)
$imageName = [IO.Path]::GetFileName($target).Replace("'", "''")

function Get-InstalledProcesses {
    Get-CimInstance -ClassName Win32_Process -Filter "Name = '$imageName'" |
        Where-Object {
            $_.ExecutablePath -and
            [string]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase)
        } |
        ForEach-Object {
            $entry = $_
            $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
            if ($process) {
                try {
                    # Hold a handle to this process and reject a reused PID.
                    $null = $process.Handle
                    if ([Math]::Abs(($process.StartTime - $entry.CreationDate).TotalMilliseconds) -lt 1) {
                        $process
                    }
                } catch {
                    if (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue) { throw }
                }
            }
        }
}

try {
    $running = @(Get-InstalledProcesses)
    if ($running.Count -eq 0) { exit 0 }
    if ($CheckOnly) { exit 1 }

    foreach ($process in $running) {
        try { if (!$process.HasExited) { $null = $process.CloseMainWindow() } }
        catch { if (!$process.HasExited) { throw } }
    }

    # An external MCP client uses the same image but has no window. Give the
    # desktop time to shut down, then terminate only processes at this path.
    Start-Sleep -Milliseconds 1500
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $idleSince = $null
    do {
        $running = @(Get-InstalledProcesses)
        if ($running.Count -eq 0) {
            if ($null -eq $idleSince) { $idleSince = [DateTime]::UtcNow }
            # A client can reconnect as soon as its MCP subprocess exits.
            if (([DateTime]::UtcNow - $idleSince).TotalMilliseconds -ge 1500) { exit 0 }
        } else {
            $idleSince = $null
        }
        foreach ($process in $running) {
            try { if (!$process.HasExited) { $process.Kill() } }
            catch { if (!$process.HasExited) { throw } }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-Output 'Processes in the Feishu Sync installation directory are still running.'
    exit 2
} catch {
    Write-Output "Could not close Feishu Sync: $($_.Exception.Message)"
    exit 2
}

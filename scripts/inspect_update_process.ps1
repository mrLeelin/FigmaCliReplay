param([Parameter(Mandatory=$true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$targetProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
if (-not $targetProcess) { throw 'Process no longer exists.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayUpdateArgs {
    [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string text, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    public static string[] Parse(string text) {
        int count; IntPtr pointer = CommandLineToArgvW(text, out count);
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("Could not parse process arguments.");
        try { string[] values = new string[count]; for (int i=0;i<count;i++) values[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i*IntPtr.Size)); return values; }
        finally { LocalFree(pointer); }
    }
}
'@
[pscustomobject]@{
    pid = [int]$targetProcess.ProcessId
    executablePath = [string]$targetProcess.ExecutablePath
    startedAt = $targetProcess.CreationDate.ToUniversalTime().ToString('o')
    arguments = [RelayUpdateArgs]::Parse($targetProcess.CommandLine)
} | ConvertTo-Json -Compress

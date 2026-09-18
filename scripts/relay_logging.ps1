class RelayScriptLogger {
    [string]$OperationId = [guid]::NewGuid().ToString('N')
    [string]$Operation
    RelayScriptLogger([string]$operation) { $this.Operation = $operation }
    [void] Write([string]$status, [string]$message) {
        $event = @{ timestamp = [DateTime]::UtcNow.ToString('o'); source = 'relay'; module = 'relay-launcher'; operationId = $this.OperationId; operation = $this.Operation; status = $status; message = $message }
        [Console]::Error.WriteLine(($event | ConvertTo-Json -Compress))
    }
}

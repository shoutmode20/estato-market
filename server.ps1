# Estato Dev Server — Simple, No Admin Required
# Uses raw TCP sockets (no HttpListener URL ACL needed)
# Run: powershell -File .\server.ps1

$port = 8080
$root = $PSScriptRoot

$mimeTypes = @{
    ".html"        = "text/html; charset=utf-8"
    ".js"          = "application/javascript; charset=utf-8"
    ".css"         = "text/css; charset=utf-8"
    ".json"        = "application/json; charset=utf-8"
    ".png"         = "image/png"
    ".jpg"         = "image/jpeg"
    ".jpeg"        = "image/jpeg"
    ".svg"         = "image/svg+xml"
    ".ico"         = "image/x-icon"
    ".txt"         = "text/plain"
    ".webmanifest" = "application/manifest+json"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
$listener.Start()

Write-Host ""
Write-Host "  Estato Dev Server is running!" -ForegroundColor Cyan
Write-Host "  Open: http://localhost:$port/" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        $client.ReceiveTimeout = 2000

        try {
            $stream = $client.GetStream()
            $buffer = New-Object byte[] 4096
            $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
            $requestText = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $bytesRead)
            $requestLine = ($requestText -split "`r`n")[0]

            $urlPath = ($requestLine -split ' ')[1]
            $urlPath = ($urlPath -split '\?')[0]
            if ($urlPath -eq "/" -or $urlPath -eq "") { $urlPath = "/index.html" }

            $localPath = $urlPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $filePath  = [System.IO.Path]::Combine($root, $localPath)

            if ([System.IO.File]::Exists($filePath)) {
                $ext      = [System.IO.Path]::GetExtension($filePath).ToLower()
                $mime     = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
                $body     = [System.IO.File]::ReadAllBytes($filePath)
                $header   = "HTTP/1.1 200 OK`r`nContent-Type: $mime`r`nContent-Length: $($body.Length)`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
                Write-Host "  200  $urlPath" -ForegroundColor DarkGray
            } else {
                $body     = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
                $mime     = "text/plain"
                $header   = "HTTP/1.1 404 Not Found`r`nContent-Type: $mime`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                Write-Host "  404  $urlPath" -ForegroundColor Yellow
            }

            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($body, 0, $body.Length)
            $stream.Flush()
        } catch {
            # Silently skip bad/incomplete requests
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
    Write-Host "  Server stopped." -ForegroundColor DarkGray
}

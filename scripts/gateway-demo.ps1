# Gateway evidence for the README / video (Windows PowerShell). Requires: docker compose up
#   powershell -ExecutionPolicy Bypass -File scripts\gateway-demo.ps1
$G = if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { "http://localhost:8000" }

Write-Host "`n=== 1) Public route: Query Bill (GET /api/v1/bills) ===" -ForegroundColor Cyan
curl.exe -s -i "$G/api/v1/bills?subscriberNo=5551001&month=10&year=2026"

Write-Host "`n`n=== 2) Protected route WITHOUT token -> 401 from the gateway ===" -ForegroundColor Cyan
curl.exe -s -i "$G/api/v1/bills/detailed?month=10&year=2026"

Write-Host "`n`n=== 3) Login -> JWT ===" -ForegroundColor Cyan
$login = curl.exe -s -X POST "$G/api/v1/auth/login" -H "Content-Type: application/json" -d '{\"subscriberNo\":\"5551001\",\"password\":\"Passw0rd!\"}' | ConvertFrom-Json
$T = $login.accessToken
Write-Host "token: $($T.Substring(0,30))..."

Write-Host "`n=== 4) Protected route WITH token -> 200 ===" -ForegroundColor Cyan
curl.exe -s -i "$G/api/v1/bills/detailed?month=10&year=2026&pageSize=2" -H "Authorization: Bearer $T"

Write-Host "`n`n=== 5) Error response: another subscriber's data -> 403 ===" -ForegroundColor Cyan
curl.exe -s -i "$G/api/v1/bills/detailed?subscriberNo=5551002&month=10&year=2026" -H "Authorization: Bearer $T"

Write-Host "`n`n=== 6) Error response: unknown route -> gateway 404 ===" -ForegroundColor Cyan
curl.exe -s -i "$G/api/v1/unknown"

Write-Host "`n`n=== 7) Rate limit: 31 calls to the public route (limit 30/min) ===" -ForegroundColor Cyan
1..31 | ForEach-Object { $code = curl.exe -s -o NUL -w "%{http_code}" "$G/api/v1/bills?subscriberNo=5551001&month=10&year=2026"; Write-Host -NoNewline "$code " }
Write-Host ""

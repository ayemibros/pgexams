# Starts the Node.js CBT UI server using this project's own .env.
# Clears inherited variables that could point it at another project's database.

Set-Location $PSScriptRoot

foreach ($v in 'DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','ONLINE_MODE','PORT') {
    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    npm install
}

Write-Host "Starting CBT UI on port 8000 (http://localhost:8000/)" -ForegroundColor Cyan
node server.js

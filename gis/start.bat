@echo off
rem PSICITS - start a local web server and open the app (Windows).
rem Uses Python if it is installed, otherwise Node.js. If neither is available,
rem just double-click index.html instead (everything but GDAL works from disk).
cd /d "%~dp0"
set PORT=8000

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://localhost:%PORT%/
  echo PSICITS is running at http://localhost:%PORT%/  - close this window to stop it.
  py -m http.server %PORT%
  goto :eof
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://localhost:%PORT%/
  echo PSICITS is running at http://localhost:%PORT%/  - close this window to stop it.
  python -m http.server %PORT%
  goto :eof
)
where node >nul 2>nul
if %ERRORLEVEL%==0 (
  start "" http://localhost:%PORT%/
  node tools\serve.js %PORT%
  goto :eof
)
echo Neither Python nor Node.js was found. Opening index.html directly instead.
start "" index.html

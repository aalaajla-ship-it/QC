@echo off
REM Quick Start Script for CableQC Desktop App
REM Date: 19 January 2026

echo.
echo ╔════════════════════════════════════════════════════════════════════╗
echo ║         CableQC Desktop Application - Quick Start                   ║
echo ║     Send Marking to Printer Feature - Testing Ready                 ║
echo ╚════════════════════════════════════════════════════════════════════╝
echo.

REM Navigate to project directory
cd /d "c:\Users\OMEN\Desktop\New Version\CableQC" || (
    echo ERROR: Could not navigate to project directory
    pause
    exit /b 1
)

echo [1/4] Checking Node.js...
node --version > nul 2>&1 || (
    echo ERROR: Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)
echo ✓ Node.js found: 
node --version

echo.
echo [2/4] Checking Rust/Cargo...
cargo --version > nul 2>&1 || (
    echo ERROR: Rust/Cargo not found. Please install Rust first.
    pause
    exit /b 1
)
echo ✓ Cargo found:
cargo --version

echo.
echo [3/4] Installing dependencies (if needed)...
call npm install > nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Warning: npm install had issues
)
echo ✓ Dependencies checked

echo.
echo [4/4] Starting development server...
echo.
echo ╔════════════════════════════════════════════════════════════════════╗
echo ║ The application will start in a moment...                           ║
echo ║                                                                      ║
echo ║ Testing Checklist:                                                   ║
echo ║ 1. Dialog opens with "Send Marking" button                          ║
echo ║ 2. Button shows spinner during send                                 ║
echo ║ 3. Result popup appears (success or error)                          ║
echo ║ 4. "Validate Wire" button enabled after success                     ║
echo ║ 5. State resets when dialog reopens                                 ║
echo ║                                                                      ║
echo ║ Press Ctrl+C to stop the development server                         ║
echo ╚════════════════════════════════════════════════════════════════════╝
echo.

call npm run tauri dev

pause

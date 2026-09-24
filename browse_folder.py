"""
KBS 송출센터 점검계획 - 윈도우 네이티브 폴더 탐색기 (내 PC/드라이브 브라우징)
STA 모드 PowerShell 및 최상위 활성 HWND Tkinter 이중 안전망 구현
"""
import sys
import os
import subprocess

def ask_folder_powershell(initial_dir=""):
    """
    PowerShell -Sta (Single Thread Apartment) 모드로 최신 Windows Vista+ 탐색기 스타일 FolderBrowserDialog 호출
    최상위(TopMost) 폼을 소유자로 지정하여 화면 최상단 전면에 무조건 노출
    """
    ps_initial = initial_dir.replace("'", "''") if (initial_dir and os.path.exists(initial_dir)) else ""
    ps_script = f"""
Add-Type -AssemblyName System.Windows.Forms
$fbd = New-Object System.Windows.Forms.FolderBrowserDialog
$fbd.Description = "점검 계획(.hwp) 폴더 선택 (내 PC / C: / D: 드라이브)"
$fbd.ShowNewFolderButton = $true
$fbd.AutoUpgradeEnabled = $true
if ('{ps_initial}' -ne '' -and (Test-Path '{ps_initial}')) {{
    $fbd.SelectedPath = '{ps_initial}'
}}
$topForm = New-Object System.Windows.Forms.Form
$topForm.TopMost = $true
$topForm.Width = 0
$topForm.Height = 0
$topForm.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$topForm.ShowInTaskbar = $false
$topForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
$topForm.Show()
$topForm.Activate()
$topForm.BringToFront()
$result = $fbd.ShowDialog($topForm)
$topForm.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {{
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $fbd.SelectedPath
}}
"""
    try:
        proc = subprocess.run(
            ["powershell", "-Sta", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120
        )
        out = proc.stdout.strip()
        if out and os.path.exists(out):
            return os.path.normpath(out)
    except Exception as e:
        sys.stderr.write(f"PowerShell Picker Error: {e}\n")
    return None

def ask_folder_tkinter(initial_dir=""):
    """
    Tkinter 폴백: root를 withdraw(숨김)하지 않고 1x1 화면 밖 배치하여 
    Windows OS가 TopMost 부모 윈도우로 온전히 인식하도록 강제
    """
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.title("점검 계획 폴더 선택")
        # withdraw 대신 화면 밖 배치하여 정상 윈도우 핸들(HWND) 유지
        root.geometry("1x1+-2000+-2000")
        root.attributes("-topmost", True)
        root.attributes("-alpha", 0.0)
        root.update_idletasks()
        root.lift()
        root.focus_force()

        selected = filedialog.askdirectory(
            parent=root,
            title="점검 계획(.hwp) 폴더 선택 (내 PC)",
            initialdir=initial_dir if (initial_dir and os.path.exists(initial_dir)) else None
        )
        root.destroy()
        if selected and os.path.exists(selected):
            return os.path.normpath(selected)
    except Exception as e:
        sys.stderr.write(f"Tkinter Picker Error: {e}\n")
    return None

def main():
    initial_dir = sys.argv[1] if len(sys.argv) > 1 and os.path.exists(sys.argv[1]) else ""
    
    # 1. PowerShell 최상위 탐색기 시도 (-Sta 모드)
    folder = ask_folder_powershell(initial_dir)
    if not folder:
        # 2. 실패 시 Tkinter 최상위 HWND 탐색기 시도
        folder = ask_folder_tkinter(initial_dir)

    if folder:
        print(folder)
        sys.exit(0)
    else:
        sys.exit(1)

if __name__ == "__main__":
    main()

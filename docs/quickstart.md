# Quickstart

TaleSide runs on Windows. Demo Worlds work without a Gemini API key.

1. Install Python 3.12 and leave the Python launcher enabled. [Python 3.12 Windows installer](https://www.python.org/downloads/release/python-31210/)
2. On the TaleSide repository page, choose **Code** → **Download ZIP** and
   extract the ZIP.
3. Open PowerShell in the extracted folder. If you want to create your own
   Worlds, close any running TaleSide launcher, run the command below, and
   paste your Gemini API key when prompted.

   ```powershell
   $env:GEMINI_API_KEY = Read-Host 'Enter your Gemini API key'
   ```

4. In the same PowerShell window, start TaleSide.

   ```powershell
   & '.\Start TaleSide.cmd'
   ```

   The homepage opens at `http://127.0.0.1:8765`. Keep the PowerShell window open.
5. Choose **Demo Worlds** from the selector in the bottom right. Hover over
   any World card to preview its artwork.

Close the PowerShell window when you’re done to stop TaleSide.

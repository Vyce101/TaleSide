# Quickstart

TaleSide runs on Windows. Demo Worlds work without an API key.

1. Install Python 3.12 and leave the Python launcher enabled. [Python 3.12 Windows installer](https://www.python.org/downloads/release/python-31210/)
2. On the TaleSide repository page, choose **Code** → **Download ZIP** and
   extract the ZIP.
3. Open PowerShell in the extracted folder and start TaleSide.

   ```powershell
   & '.\Start TaleSide.cmd'
   ```

   The homepage opens at `http://127.0.0.1:8765`. Keep the PowerShell window open.
4. Open **Settings** with the gear and choose **Developer Options** →
   **Worlds Preview** → **Demo Worlds**.
5. Click the gear again to close Settings. Hover over a World card to preview it
   and click **Enter** to open it.

Close the PowerShell window when you’re done to stop TaleSide.

## Create your own World

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. In TaleSide, open **Settings** → **API Keys** → **Add API Key**. Name the key,
   paste it, and click **Save Key**. Click the gear again to close Settings.
3. Open **Create** and use **Add Books** to select one or more TXT files. In
   **World Settings**, confirm which **Embedding Key** TaleSide will use.
4. Click **Create** to start. TaleSide sends book titles and chunks of text to
   Google Gemini to count tokens and create embeddings. Once the World is saved,
   you can follow its progress from **Worlds**.

## Start a Tale

1. Open a Ready World and select **New Tale**, or use **Play** to resume its
   most recently active Tale.
2. Open **Tale Settings** and select a **Chat Key** for Gemini 4 Hydrogen.
   The **Retrieval Key** starts with the key used to create the World. You can
   change it independently in the Tales tab or Tale Settings.
3. Send a message. TaleSide sends recent messages to Gemini Embedding 2 for
   search. It sends World information, matching book passages, and the
   conversation to Gemini 4 Hydrogen for the reply. With **Thought signatures**
   on, TaleSide also sends the signatures Gemini returned for prior replies.

Tales, messages, and chat profiles are saved in the local TaleSide database.

# Run TaleSide on Windows

1. Install the Windows x64 build of [Node.js 24 LTS](https://nodejs.org/en/download/archive/v24) (24.11.1 or later in the 24.x series) and [Python 3.12](https://www.python.org/downloads/release/python-31210/). Enable the Python launcher during setup.
2. On the [TaleSide repository page](https://github.com/Vyce101/TaleSide), choose **Code → Download ZIP** and extract it.
3. Open PowerShell in the extracted folder and run `npm ci` once to install the dependencies.
4. Double-click **Start TaleSide.cmd**. TaleSide opens in your browser. Keep the launcher window open while you use it.

## Start your first Tale

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey). In TaleSide, open **API Keys**, choose **Add Key**, then name and save the key.
2. Open **Worlds**, choose **New World** with the **+** button, and enter a name. Use the **+** beside **Books** to add one small `.txt` book.
3. In **Indexing**, select the key you just saved under **Embedding key**. Under **Graph RAG**, set **Extraction model** to **Gemini 3.5 Flash-Lite** and **Extraction thinking level** to **Minimal**. Select the same key under **Extraction keys**, then click the **Create World** checkmark.
4. Open **Tale Settings**. Under **Model and reasoning**, select the same key in **Chat key**.
5. Close Tale Settings. Once the first passage is indexed, send a message and wait for Gemini to reply. The World’s **First Message** is the opening you see before you send anything. Chat starts using character and relationship write-ups after the current set of books finishes indexing.

If indexing reports skipped items or a book edit leaves it paused, click **Resume indexing** to continue from saved work. **World progress** shows how many chunks have been indexed and extracted for each book.

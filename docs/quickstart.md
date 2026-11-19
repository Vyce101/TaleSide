# Quickstart

TaleSide runs on Windows. Use Demo Worlds to preview the interface without an API key. To start a Tale, follow **Create your own World** below.

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
3. Open **Create** and use **Add Books** to select a TXT book. In
   **World Settings**, make sure your key is selected under **Embedding Key**.
4. Click **Create**. TaleSide sends book titles and chunks of text to Google
   Gemini to count tokens and create embeddings. Open your new World from
   **Worlds** and wait for its status to show **Ready**.

## Start a Tale

1. In the **Tales** tab of your new World, select **New Tale**.
2. Open **Tale Settings** and select the same Gemini key under **Chat Key**.
   The **World Retrieval Key** is already set from World creation.
3. Send a message.

TaleSide sends recent messages to Gemini Embedding 2 to find relevant book
passages. It sends World information, matching passages, and the conversation
to Gemini 4 Hydrogen for the reply. With **Thought signatures** on, TaleSide
also sends the signatures Gemini returned for prior replies. If Gemini rejects
a reply request because the input is too long, that send ends and the
transcript keeps its history.

Tales, messages, and chat profiles are saved in the local TaleSide database.
Use **Play** on the World screen to reopen its most recently active Tale.

**Using multiple keys.** You can select more than one key for embedding,
retrieval, or chat. Click a key to select or clear it, then close the dropdown
to save. Each selection cycles in the order you picked the keys and advances
after every request attempt. Closing and restarting the launcher resets each
cycle to its first key.

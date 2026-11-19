# Changelog

## Unreleased

### Added

- Tales for saved Worlds with book-grounded Gemini 4 Hydrogen chat and shared chat profiles. Resume saved Tales or stop a reply and keep its partial text.
- Sent messages appear immediately, and streaming thought summaries support Markdown. A reply request rejected for length ends the send and keeps the conversation history.
- Windows launcher that opens TaleSide in a local browser. Worlds and encrypted keys are stored in `data/` inside the TaleSide folder. Existing databases in `%LOCALAPPDATA%\TaleSide` must be moved to `data/` to keep using them.
- Worlds homepage with an empty state and demo Worlds that show creation progress, pause, and failure states. The Worlds Preview selector is in **Settings → Developer Options**.
- TXT processing that preserves original files, saves vectors from `gemini-embedding-2` using the World’s selected keys, and resumes from saved progress.
- Create Worlds from ordered TXT books, choose an embedding model and keys, and review chunks that exceed the model’s token limit before saving. Open saved Worlds to track progress, change embedding keys while creation is idle, rename them, or discard them.
- Multi-select dropdowns for embedding, retrieval, and chat keys. Each selection cycles through its keys in order and advances on every request attempt.
- App Settings for adding, renaming, replacing, and deleting Google Gemini API keys. Deleting a key removes it from its assignments and keeps the other selected keys. Empty selections require a new choice.

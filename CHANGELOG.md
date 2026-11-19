# Changelog

## Unreleased

### Added

- Tales for saved Worlds with book-grounded Gemini 4 Hydrogen chat and shared chat profiles. Resume saved Tales or stop a reply and keep its partial text.
- Sent messages appear immediately, and streaming thought summaries support Markdown. A reply request rejected for length ends the send and keeps the conversation history.
- Windows launcher that opens TaleSide in a local browser. Worlds and encrypted keys are stored in `data/` inside the TaleSide folder. Existing databases in `%LOCALAPPDATA%\TaleSide` must be moved to `data/` to keep using them.
- Worlds homepage with an empty state and demo Worlds that show creation progress, pause, and failure states. The Worlds Preview selector is in **Settings → Developer Options**.
- TXT processing that preserves original files, fits embedding inputs to the model’s token limit during indexing, and resumes from saved progress. Tales can retrieve passages as chunks finish indexing.
- Create Worlds from ordered TXT books and choose an embedding model and keys. Add, reorder, and remove books while indexing is idle. Reindex saved books with new settings from World Settings.
- Multi-select dropdowns for embedding, retrieval, and chat keys. Each selection cycles through its keys in order and advances on every request attempt.
- App Settings for adding, renaming, replacing, and deleting Google Gemini API keys. Deleting a key removes it from its assignments and keeps the other selected keys. Empty selections require a new choice.

# Changelog

## Unreleased

### Added

- Windows launcher that opens TaleSide in a local browser. Worlds and encrypted keys are stored in `data/` inside the TaleSide folder. Existing databases in `%LOCALAPPDATA%\TaleSide` must be moved to `data/` to keep using them.
- Worlds homepage with an empty state and demo Worlds that show creation progress, pause, and failure states. The Worlds Preview selector is in **Settings → Developer Options**.
- TXT processing that preserves original files, saves vectors from `gemini-embedding-2` using the World’s selected key, and resumes from saved progress.
- Create Worlds from ordered TXT books, choose an embedding model and key, and review chunks that exceed the model’s token limit before saving. Open saved Worlds to track progress, change the embedding key while creation is idle, rename them, or discard them.
- App Settings for adding, renaming, replacing, and deleting Google Gemini API keys. The delete confirmation lists affected Worlds. Those Worlds switch to another Gemini key if available, or lose their key assignment until one is chosen.

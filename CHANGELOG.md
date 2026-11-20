# Changelog

## Unreleased

### Added

- TaleSide's browser UI opens on Recent Tales. Open a World to resume its latest Tale or start a blank chat that saves on the first message.
- Create Worlds with a name and optional artwork or TXT books. Rename Worlds and edit artwork at any time. Add, rename, reorder, and remove books while indexing is idle.
- Pause, resume, and clear indexing from the World sidebar. Keep books and Tales when clearing an index. See the overall percentage at a glance and per-book chunk counts under World progress. Chat unlocks as soon as the first passage is ready.
- TXT processing that keeps original files, fits embedding inputs to the model's token limit, and resumes from saved progress.
- Book-grounded Gemini 4 Hydrogen chat with streamed Markdown replies and expandable thoughts as they arrive. Thought summaries show the duration in whole seconds. Stop a reply or leave its Tale to save partial text. Input limit failures keep the conversation history.
- Tale Settings with named chat profiles, model and reasoning controls, retrieval settings, and editable XML wrappers.
- Google AI Studio keys with creation, renaming, replacement, deletion, and World assignments. Choose multiple keys for embedding, retrieval, and chat. Each selection advances on each request attempt.
- Windows launcher with a Node.js and TypeScript server and browser UI. Python prepares books and retrieves passages. The launcher stores Worlds and encrypted keys in the TaleSide folder and backs up older databases before migration.

# Changelog

## Unreleased

### Added

- TaleSide's browser UI opens on Recent Tales. Open a World to resume its latest Tale or start a blank chat that saves on the first message.
- Create Worlds with a name and optional cropped artwork or TXT, Markdown, HTML, and EPUB books. Rename Worlds and edit artwork at any time. Add, rename, reorder, and remove books while indexing is idle.
- Pause, resume, and clear indexing from the World sidebar. Keep books and Tales when clearing an index. See the overall percentage at a glance and per-book chunk counts under World progress. Chat unlocks as soon as the first passage is ready.
- Book processing that keeps original files and extracts readable HTML and EPUB text in reading order. Indexing searches the last 10% of each chunk for a natural break, fits inputs to the model’s token limit, and resumes from saved progress.
- Book-grounded Gemini 4 Hydrogen chat with streamed Markdown replies and expandable thoughts as they arrive. Thought summaries show the duration in whole seconds. Stop a reply or leave its Tale to save partial text. Input limit failures keep the conversation history.
- Tale Settings with named chat profiles, model and reasoning controls, retrieval settings, and editable XML wrappers.
- Google AI Studio keys with creation, renaming, replacement, deletion, and World assignments. Choose multiple keys for embedding, retrieval, and chat. Each selection advances on each request attempt.
- Quiet Windows launcher with prerequisite checks, startup and shutdown status, and database backup notices. Python prepares books and retrieves passages. Worlds and encrypted keys live in the TaleSide folder.
- Search Worlds by name, book name, or filename. Search Tale titles and messages with highlighted previews, and find any World’s Tales from Home.
- Dismissible app notifications and saved provider errors on failed replies and Worlds. Hover over a temporary notification to keep it until dismissed.
- If a chat request fails before Gemini streams any text, TaleSide tries the next selected chat key. It stops at the first success and shows the final provider error if every selected key fails once. Book indexing and passage retrieval also retry eligible provider failures with their selected keys.
- Forest-green app branding, a browser icon that adapts to light and dark themes, and wing-centered default World pictures.

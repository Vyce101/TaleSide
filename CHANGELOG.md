# Changelog

## Unreleased

### Added

- TaleSide's browser UI opens on Recent Tales. Open a World to resume its latest Tale or start a new chat that saves on the first message.
- Create Worlds with a name and optional cropped artwork or TXT, Markdown, HTML, and EPUB books. Rename Worlds and edit artwork at any time. Add, rename, reorder, and remove books while indexing is idle.
- Pause, resume, and clear indexing from the World sidebar. Keep books and Tales when clearing an index. See the overall percentage at a glance and per-book chunk counts under World progress. Chat unlocks as soon as the first passage is ready.
- Book processing that keeps original files and extracts readable HTML and EPUB text in reading order. Indexing searches the last 10% of each chunk for a natural break, fits inputs to the model’s token limit, and resumes from saved progress.
- Book-grounded Gemini 4 Hydrogen chat with streamed Markdown replies and expandable thoughts as they arrive. Reply times update live, and reply and thought durations use compact minutes and seconds. Stop a reply or leave its Tale to save partial text. Input limit failures keep the conversation history.
- Edit, branch, and delete individual Tale messages. Saving a change to a signed AI reply clears its Gemini thinking signature. Regenerate the last AI reply or keep multiple alternatives with their own Thoughts and timing. Failed attempts stay in their swipe slots. Send without keys to save a user message, then answer it later from the final turn.
- Tale Settings with named presets, reorderable prompt blocks, model and reasoning controls, retrieval settings, and editable XML wrappers. Prompt blocks show their character counts from the Tale’s last request. Custom presets can assign a role to every block, and Tale Settings remembers which sections are collapsed. The built-in Default preset keeps your saved chat keys, model, and reasoning settings and resets its other settings to the new defaults.
- Give Worlds a description and multiple First Messages. Choose an opening before the first send and keep it with the Tale.
- Create Personas with a name, portrait, and description. Set World and global defaults, and switch Personas within a Tale.
- Google AI Studio keys with creation, renaming, replacement, deletion, and World assignments. Choose multiple keys for embedding, retrieval, and chat. Shift-click selects or clears a range. Each selection advances on each request attempt.
- Quiet Windows launcher with prerequisite checks, startup and shutdown status, and database backup notices. Python prepares books and retrieves passages. Worlds and encrypted keys live in the TaleSide folder.
- Search Worlds by name, book name, or filename. Search Tale titles and messages with highlighted previews, and find any World’s Tales from Home.
- Dismissible app notifications, persistent chat error toasts, and saved provider errors for Worlds. Hover over a temporary notification to keep it until dismissed.
- If a chat request fails before Gemini streams any text, TaleSide tries the next selected chat key. It stops at the first success and shows the final provider error if every selected key fails once. Book indexing and passage retrieval also retry eligible provider failures with their selected keys.
- Forest-green app branding, a browser icon that adapts to light and dark themes, and wing-centered default World pictures.

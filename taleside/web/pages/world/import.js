export function createWorldImport({ request, ask, onReportChange, onSaving }) {
  let attempt = null;

  function cancel() {
    if (!attempt) return;
    const { route, controller } = attempt;
    attempt = null;
    controller.abort();
    request(`${route}/cancel`, { method: "POST", keepalive: true }).catch(() => {});
  }

  async function save(settings, books) {
    if (!attempt) {
      const id = crypto.randomUUID().replaceAll("-", "");
      attempt = {
        route: `/api/world-imports/${id}`,
        controller: new AbortController(),
        report: null,
        approved: false,
      };
    }

    const submission = attempt;
    const { route, controller: { signal } } = submission;
    try {
      if (!submission.report) {
        const body = bookUpload(settings, books);
        submission.report = await request(`${route}/prepare`, { method: "POST", body, signal });
      }
      if (attempt !== submission) return null;
      onReportChange();

      if (submission.report.oversized_chunks.length && !submission.approved) {
        submission.approved = await confirmOversized(ask, submission.report);
        if (attempt !== submission) return null;
        if (!submission.approved) {
          cancel();
          onReportChange();
          return null;
        }
      }

      onSaving();
      const { world } = await request(`${route}/accept`, {
        method: "POST", json: { allow_oversized: submission.approved }, signal,
      });
      if (attempt !== submission) return null;
      if (!world) throw new Error("This World could not be found after saving.");
      attempt = null;
      return world;
    } catch (error) {
      if (attempt !== submission) return null;
      if (!submission.report || error.status === 409) cancel();
      throw error;
    }
  }

  return {
    cancel,
    save,
    get chunkCount() { return attempt?.report?.chunk_count; },
  };
}

function bookUpload(settings, books) {
  const body = new FormData();
  body.append("settings", JSON.stringify({
    ...settings,
    books: books.map(book => ({ name: book.name, filename: book.filename })),
  }));
  for (const book of books) body.append("book", book.file);
  return body;
}

function confirmOversized(ask, { oversized_chunks: oversized, token_limit: limit }) {
  const first = oversized[0];
  const count = `${oversized.length} ${oversized.length === 1 ? "chunk exceeds" : "chunks exceed"}`;
  return ask("Chunk Size Too Large",
    `${count} Gemini’s ${limit.toLocaleString()}-token limit. Book ${first.book_number}, chunk ${first.chunk_number} is ${first.tokens.toLocaleString()} tokens. If you continue, TaleSide will embed only the beginning of each oversized chunk that fits and keep the full text saved.`,
    "Back to setup", "Continue anyway");
}

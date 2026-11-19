export function createWorldImport({ request, onReportChange }) {
  let attempt = null;

  function cancel() {
    if (!attempt) return;
    const { route, controller } = attempt;
    attempt = null;
    controller.abort();
    request(`${route}/cancel`, { method: "POST", keepalive: true }).catch(() => {});
  }

  async function save(settings, books, { reindex = false } = {}) {
    if (!attempt) {
      const id = crypto.randomUUID().replaceAll("-", "");
      attempt = {
        route: `/api/world-imports/${id}`,
        controller: new AbortController(),
        report: null,
      };
    }

    const submission = attempt;
    const { route, controller: { signal } } = submission;
    try {
      if (!submission.report) {
        submission.report = reindex
          ? await request(`${route}/prepare-reindex`, { method: "POST", json: settings, signal })
          : await request(`${route}/prepare`, { method: "POST", body: bookUpload(settings, books), signal });
      }
      if (attempt !== submission) return null;
      onReportChange?.();
      const { world } = await request(`${route}/accept`, { method: "POST", json: {}, signal });
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

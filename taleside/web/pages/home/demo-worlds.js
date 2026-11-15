const demoArt = "/assets/demo/";
const demos = [
  ["last-of-us", "The Last of Us Part II"],
  ["death-stranding", "Death Stranding", "creating", 34],
  ["ghost-of-tsushima", "Ghost of Tsushima"],
  ["silent-hill", "Silent Hill 2", "paused", 53],
  ["cyberpunk", "Cyberpunk 2077"],
  ["need-for-speed", "Need for Speed Heat", "failed", 67],
  ["red-dead", "Red Dead Redemption II"],
  ["shadow-of-the-colossus", "Shadow of the Colossus"],
  ["elden-ring", "Elden Ring Nightreign"],
];

export function createDemoWorlds() {
  return demos.map(([slug, name, status = "ready", progress = 100]) => ({
    id: `demo-${slug}`, name, status, progress,
    cover: slug === "cyberpunk" ? null : `${demoArt}${slug}-cover.jpg`,
    wide: `${demoArt}${slug}-wide.jpg`,
    model: "gemini-embedding-2", dimensions: 768, max_chunk_size: 8000, boundary_search_distance: 1000,
    total_chunks: 100,
    error: status === "failed" ? "Could not reach Gemini for embedContent." : null,
    books: [55, 45].map((total_chunks, index) => ({
      number: index + 1, name: `${name} · Book ${index + 1}`, filename: `Book ${index + 1}.txt`,
      total_chunks,
    })),
  }));
}

export function updateDemoProgress(world) {
  world.embedded_chunks = world.progress;
  for (const book of world.books) {
    const remaining = world.progress - (book.number === 2 ? world.books[0].total_chunks : 0);
    book.embedded_chunks = Math.max(0, Math.min(book.total_chunks, remaining));
  }
  world.active_book = ["creating", "pausing"].includes(world.status)
    ? world.books.find(book => book.embedded_chunks < book.total_chunks)?.number : null;
  return world;
}

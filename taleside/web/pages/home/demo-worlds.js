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
  }));
}

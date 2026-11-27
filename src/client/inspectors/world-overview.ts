import type { InspectorOverview } from "../../shared/inspectors.js";
import { icon } from "../view.js";
import { count, el, heading, iconControl, muted, notice, patchList, setIconControl, setMeter } from "./ui.js";

export function overviewView(change: (action: "pause" | "resume") => Promise<void>) {
  const root = el("div", "inspector-list");
  const progress = el("strong", "inspector-overall");
  const control = iconControl("Pause Indexing", "pause", () => { void submit(); });
  control.classList.add("inspector-toggle-icon");
  const issue = el("div");
  const stats = el("div", "inspector-stats");
  const cards = ["Books", "Total chunks", "Embedded chunks", "Extracted chunks", "Entities", "Relationships"].map(label => {
    const card = el("div", "inspector-stat");
    const value = el("strong");
    card.append(value, el("span", "inspector-muted", label));
    stats.append(card);
    return value;
  });
  const pipeline = el("div", "inspector-list");
  let data: InspectorOverview;
  let busy = false;
  const overall = el("div", "inspector-overall-label");
  const progressLine = el("div", "inspector-overall-value");
  progressLine.append(progress, control);
  overall.append(muted("Overall Indexing Progress"), progressLine);
  root.append(overall, issue, stats, heading("Indexing Pipeline"), pipeline);
  async function submit() {
    if (busy) return;
    const action = data.world.status === "creating" ? "pause" : "resume";
    busy = control.disabled = true;
    issue.replaceChildren();
    try { await change(action); }
    catch (error) { if (root.isConnected) issue.replaceChildren(notice(error, () => { void submit(); })); }
    finally { busy = false; control.disabled = data.world.status === "pausing"; }
  }
  return {
    root,
    update(overview: InspectorOverview) {
      data = overview;
      const { world } = overview;
      progress.textContent = `${Math.floor(world.progress)}%`;
      progress.setAttribute("aria-label", `Indexing ${Math.floor(world.progress)} percent · ${world.status}`);
      control.hidden = !["creating", "pausing", "paused", "failed"].includes(world.status);
      control.disabled = busy || world.status === "pausing";
      const working = world.status === "creating" || world.status === "pausing";
      const action = world.status === "pausing" ? "Pausing Indexing" : working ? "Pause Indexing" : "Resume Indexing";
      setIconControl(control, action, working ? "pause" : "play");
      if (!busy && world.error && !issue.childElementCount) issue.append(notice(world.error));
      if (!world.error && issue.children.length && !issue.querySelector("button")) issue.replaceChildren();
      const extracted = world.books.reduce((sum, book) => sum + book.extracted_chunks, 0);
      for (const [index, value] of [world.books.length, world.total_chunks, world.embedded_chunks, extracted,
        overview.entities, overview.relationships].entries()) cards[index].textContent = count(value);
      const updateStage = (row: HTMLElement, stage: InspectorOverview["stages"][number]) => {
        const state = row.querySelector<HTMLElement>(".inspector-stage-status")!;
        if (row.dataset.state !== stage.status) {
          row.dataset.state = stage.status;
          state.replaceChildren(stage.status);
          if (stage.status === "Running") state.prepend(el("span", "inspector-spinner"));
          if (stage.status === "Complete") {
            const check = el("span", "inspector-stage-check");
            check.innerHTML = icon("check");
            state.prepend(check);
          }
        }
        const unit = stage.name.includes("books") || stage.name.includes("chunks") || stage.name === "Extract graph notes" ? "chunks" : "records";
        const progressText = stage.total === null ? count(stage.done) : `${count(stage.done)} / ${count(stage.total)}`;
        row.lastElementChild!.textContent = stage.status === "Waiting" || (!stage.done && stage.total === null) ? "—"
          : stage.name === "Publish graph" ? "" : `${progressText} ${stage.total === null && stage.done === 1 ? unit.slice(0, -1) : unit}`;
        setMeter(row.querySelector("progress")!, stage.done, stage.total, stage.name, stage.status);
      };
      patchList(pipeline, overview.stages, stage => stage.name, stage => {
        const row = el("div", "inspector-pipeline-row");
        const label = el("div", "inspector-between");
        label.append(el("span", "", stage.name), el("span", "inspector-stage-status inspector-muted"));
        row.append(label, el("progress", "inspector-meter"), muted(""));
        updateStage(row, stage);
        return row;
      }, updateStage);
    },
  };
}

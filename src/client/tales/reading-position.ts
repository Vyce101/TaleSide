import { element } from "../dom.js";

export function keepReadingPosition(update: () => void, follow = true) {
  const transcript = document.getElementById("transcript");
  if (!transcript || !transcript.clientHeight) {
    update();
    return;
  }

  const atEnd = follow && transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop < 3;
  if (atEnd) {
    update();
    transcript.scrollTop = transcript.scrollHeight;
    return;
  }

  const viewportTop = transcript.getBoundingClientRect().top;
  const turns = transcript.querySelectorAll(".turn");
  let first = 0;
  let last = turns.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (turns[middle].getBoundingClientRect().bottom > viewportTop) last = middle;
    else first = middle + 1;
  }
  const passage = Array.from(turns[first]?.querySelectorAll<HTMLElement>("[data-passage]") ?? [])
    .find(paragraph => paragraph.getBoundingClientRect().bottom > viewportTop);
  const bounds = passage?.getBoundingClientRect();
  const position = bounds ? (viewportTop - bounds.top) / Math.max(1, bounds.height) : 0;
  const scrollTop = transcript.scrollTop;

  update();
  if (passage && bounds && transcript.clientHeight) {
    const matchingPassage = passage.isConnected
      ? passage
      : transcript.querySelector(`[data-passage="${passage.dataset.passage}"]`);
    if (!matchingPassage) {
      transcript.scrollTop = scrollTop;
      return;
    }
    const resized = matchingPassage.getBoundingClientRect();
    const offset = position > 0 ? position * resized.height : position * bounds.height;
    transcript.scrollTop += resized.top + offset - transcript.getBoundingClientRect().top;
  } else {
    transcript.scrollTop = scrollTop;
  }
}

export function scrollToLatest() {
  const transcript = element("transcript");
  transcript.scrollTop = transcript.scrollHeight;
}

export function followLatestDuringResize(transcript: HTMLElement, motion: Animation) {
  let lastScrollTop = transcript.scrollTop;
  const observer = new ResizeObserver(() => {
    if (!transcript.isConnected || Math.abs(transcript.scrollTop - lastScrollTop) > 2) {
      observer.disconnect();
      return;
    }
    transcript.scrollTop = transcript.scrollHeight;
    lastScrollTop = transcript.scrollTop;
  });
  observer.observe(transcript);
  const stop = () => observer.disconnect();
  motion.finished.then(stop, stop);
}

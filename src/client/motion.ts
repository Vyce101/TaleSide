const openDurationMs = 150;
const closeDurationMs = 110;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const active = new WeakMap<HTMLElement, { visible: boolean; animation: Animation }>();

export function animateSurface(element: HTMLElement, frames: Keyframe[], duration = openDurationMs) {
  if (reducedMotion.matches) return;
  return element.animate(frames, { duration, easing: "ease-out", fill: "both" });
}

export function setSurfaceVisible(element: HTMLElement, visible: boolean, frames: [Keyframe, Keyframe], after?: () => void) {
  const previous = active.get(element);
  if (previous?.visible === visible) return previous.animation;
  if (!previous && element.hidden === !visible) {
    after?.();
    return;
  }
  previous?.animation.cancel();
  element.inert = !visible;
  element.hidden = false;
  const animation = animateSurface(element, visible ? frames : [...frames].reverse(), visible ? openDurationMs : closeDurationMs);
  const settle = () => {
    element.hidden = !visible;
    after?.();
  };
  if (!animation) {
    active.delete(element);
    settle();
    return;
  }
  active.set(element, { visible, animation });
  animation.onfinish = () => {
    active.delete(element);
    settle();
    animation.cancel();
  };
  return animation;
}

export const slideFrames: [Keyframe, Keyframe] = [
  { opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "translateY(0)" },
];

export const historyFrames: [Keyframe, Keyframe] = [{ flexBasis: "0%" }, { flexBasis: "75%" }];

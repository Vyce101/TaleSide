import type { InspectorEdge, InspectorNode } from "../../shared/inspectors.js";
import { GraphLayout, communityCenters, connectivitySeeds, graphRadius, type GraphBody, type GraphPoint as Point } from "./graph-layout.js";
import { button, el, reducedMotion } from "./ui.js";

type MapNode = InspectorNode & { muted?: boolean };
type MapEdge = InspectorEdge & { muted?: boolean };
type Node = MapNode & GraphBody & { changed: number; added: number };
type Edge = MapEdge & { from: Node; to: Node; changed: number; added: number };
type Camera = Point & { scale: number };
const linkCurvature = 0.25;
const arrowLength = 10;
const warmupTicks = 100;
const cooldownTicks = 220;
const fitPadding = 40;
const cameraDuration = 400;
const effectDuration = 600;
const communityNodeSpacing = 33;
const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const typeColors: Readonly<Record<string, string>> = {
  CHARACTER: "#a6e8ca",
  LOCATION: "#8fbcf0",
  "FACTION/GROUP": "#eed18b",
  SYSTEM_OR_WORLD_RULE: "#d9a9db",
  ITEM: "#efad92",
  EVENT: "#79cdd1",
};
function controlPoint(edge: Edge) {
  const { from, to } = edge;
  return {
    x: (from.x + to.x) / 2 - (to.y - from.y) * linkCurvature,
    y: (from.y + to.y) / 2 + (to.x - from.x) * linkCurvature,
  };
}

function curvePoint(edge: Edge, control: Point, t: number) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * edge.from.x + 2 * inverse * t * control.x + t * t * edge.to.x,
    y: inverse * inverse * edge.from.y + 2 * inverse * t * control.y + t * t * edge.to.y,
  };
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const squared = dx * dx + dy * dy;
  const position = squared ? ((point.x - start.x) * dx + (point.y - start.y) * dy) / squared : 0;
  const fraction = Math.max(0, Math.min(1, position));
  return Math.hypot(point.x - start.x - dx * fraction, point.y - start.y - dy * fraction);
}

export function createGraphMap(open: (id: string) => void, label: string) {
  const root = el("div", "inspector-graph-map");
  const canvas = el("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", `${label}. Use arrow keys to pan, plus or minus to zoom, or Search Graph to open a record.`);
  const stage = el("div", "inspector-map-stage");
  const info = el("div", "inspector-graph-info");
  const empty = el("p", "inspector-map-empty", "Loading graph…");
  const zoomIn = button("+", () => zoom(1.3, width / 2, height / 2));
  zoomIn.setAttribute("aria-label", "Zoom In");
  zoomIn.dataset.tooltip = "Zoom In";
  const zoomOut = button("−", () => zoom(1 / 1.3, width / 2, height / 2));
  zoomOut.setAttribute("aria-label", "Zoom Out");
  zoomOut.dataset.tooltip = "Zoom Out";
  const zoomControls = el("div", "inspector-controls inspector-map-zoom");
  zoomControls.append(zoomIn, zoomOut, button("Fit", () => { initialFitDone = true; fit(true); }));
  stage.append(canvas, zoomControls, empty, info);
  root.append(stage);

  const context = canvas.getContext("2d")!;
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const neighbors = new Map<string, Set<string>>();
  const layout = new GraphLayout<Node>();
  let bodies: Node[] = [];
  let hubs = new Set<string>();
  let warmup = 0;
  let ticks = 0;
  let paused = false;
  let width = 1;
  let height = 1;
  let pixels = 1;
  let visible = false;
  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let cameraMove: { from: Camera; to: Camera; started: number } | undefined;
  let initialFitDone = false;
  let frame = 0;
  let hover: Node | Edge | undefined;
  let selected: string | undefined;
  let dragging: { point: Point; node?: Node; moved: boolean } | undefined;
  let nodeColor = "#a8ecd1";
  let linkColor = "#598a75";
  let labelColor = "#e1eee6";

  const itemById = (id?: string) => id === undefined ? undefined : nodes.get(id) ?? edges.get(id);

  function schedule() { if (!frame) frame = requestAnimationFrame(draw); }

  function moveCamera(to: Camera, animate: boolean) {
    if (animate && !reducedMotion.matches) cameraMove = { from: camera, to, started: performance.now() };
    else { camera = to; cameraMove = undefined; }
    schedule();
  }

  function fit(animate: boolean) {
    if (!bodies.length || width < 80 || height < 80) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of bodies) {
      const radius = graphRadius(node.degree);
      minX = Math.min(minX, node.x - radius); maxX = Math.max(maxX, node.x + radius);
      minY = Math.min(minY, node.y - radius); maxY = Math.max(maxY, node.y + radius);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return false;
    const scale = Math.min(2, Math.max(0.005, Math.min(
      (width - fitPadding * 2) / (maxX - minX), (height - fitPadding * 2) / (maxY - minY),
    )));
    moveCamera({ x: width / 2 - (minX + maxX) * scale / 2, y: height / 2 - (minY + maxY) * scale / 2, scale }, animate);
    return true;
  }

  function zoom(multiplier: number, x: number, y: number) {
    initialFitDone = true;
    const scale = Math.max(0.005, Math.min(15, camera.scale * multiplier));
    const fraction = scale / camera.scale;
    moveCamera({ x: x - (x - camera.x) * fraction, y: y - (y - camera.y) * fraction, scale }, false);
  }

  const observer = new ResizeObserver(() => {
    const bounds = stage.getBoundingClientRect();
    visible = bounds.width > 0 && bounds.height > 0;
    if (!visible) return;
    const dx = (bounds.width - width) / 2;
    const dy = (bounds.height - height) / 2;
    camera = { ...camera, x: camera.x + dx, y: camera.y + dy };
    if (cameraMove) {
      for (const endpoint of [cameraMove.from, cameraMove.to]) { endpoint.x += dx; endpoint.y += dy; }
    }
    width = bounds.width;
    height = bounds.height;
    pixels = Math.min(devicePixelRatio, 2);
    canvas.width = Math.ceil(width * pixels);
    canvas.height = Math.ceil(height * pixels);
    const theme = getComputedStyle(stage);
    nodeColor = theme.getPropertyValue("--inspector-graph-node").trim() || nodeColor;
    linkColor = theme.getPropertyValue("--inspector-graph-link").trim() || linkColor;
    labelColor = theme.getPropertyValue("--inspector-graph-label").trim() || labelColor;
    schedule();
  });
  observer.observe(stage);

  function load(graph: { nodes: MapNode[]; edges: MapEdge[] }) {
    const now = performance.now();
    const hadNodes = nodes.size > 0;
    const names = new Set(graph.nodes.map(node => node.id));
    const additions: Node[] = [];
    let topologyChanged = false;
    for (const id of nodes.keys()) if (!names.has(id)) { nodes.delete(id); topologyChanged = true; }
    for (const node of graph.nodes) {
      const current = nodes.get(node.id);
      if (current) {
        if (current.version !== node.version) current.changed = now;
        Object.assign(current, node);
      } else {
        const pending = { ...node, x: 0, y: 0, vx: 0, vy: 0, degree: 0, changed: now, added: now };
        nodes.set(node.id, pending);
        additions.push(pending);
        topologyChanged = true;
      }
    }
    neighbors.clear();
    const links = new Set(graph.edges.map(edge => edge.id));
    for (const id of edges.keys()) if (!links.has(id)) { edges.delete(id); topologyChanged = true; }
    for (const edge of graph.edges) {
      const from = nodes.get(edge.source);
      const to = nodes.get(edge.target);
      if (!from || !to || from === to) continue;
      const previous = edges.get(edge.id);
      topologyChanged ||= !previous || from !== previous.from || to !== previous.to;
      edges.set(edge.id, { ...edge, from, to, added: previous?.added ?? now,
        changed: previous?.version === edge.version ? previous.changed : now });
      for (const [a, b] of [[from.id, to.id], [to.id, from.id]]) {
        let next = neighbors.get(a);
        if (!next) neighbors.set(a, next = new Set());
        next.add(b);
      }
    }
    bodies = [...nodes.values()];
    for (const node of bodies) node.degree = neighbors.get(node.id)?.size ?? 0;
    hubs = new Set(bodies.filter(node => node.degree > 1).sort((a, b) => b.degree - a.degree).slice(0, 10).map(node => node.id));
    if (topologyChanged) {
      const centers = communityCenters(nodes, neighbors);
      const positions = additions.length ? connectivitySeeds(nodes, neighbors) : undefined;
      const newIds = new Set(additions.map(node => node.id));
      const settledCenters = new Map<Point, { x: number; y: number; count: number }>();
      for (const node of bodies) {
        node.community = centers.get(node.id);
        if (!node.community || newIds.has(node.id)) continue;
        let center = settledCenters.get(node.community);
        if (!center) settledCenters.set(node.community, center = { x: 0, y: 0, count: 0 });
        center.x += node.x; center.y += node.y; center.count++;
      }
      // Keep established coordinates stable when indexing adds nodes and edges.
      for (const [center, total] of settledCenters) {
        center.x = total.x / total.count;
        center.y = total.y / total.count;
      }
      const groupSizes = new Map<Point, number>();
      for (const [addition, node] of additions.entries()) {
        if (!node.community) {
          const linked = [...neighbors.get(node.id) ?? []].find(id => !newIds.has(id));
          const anchor = linked ? nodes.get(linked)! : undefined;
          const angle = addition * goldenAngle;
          Object.assign(node, anchor
            ? { x: anchor.x + 120 * Math.cos(angle), y: anchor.y + 120 * Math.sin(angle) }
            : positions!.get(node.id)!);
          continue;
        }
        const index = groupSizes.get(node.community) ?? 0;
        groupSizes.set(node.community, index + 1);
        const radius = communityNodeSpacing * Math.sqrt(index);
        node.x = node.community.x + radius * Math.cos(index * goldenAngle);
        node.y = node.community.y + radius * Math.sin(index * goldenAngle);
      }
      layout.alpha = hadNodes ? Math.max(layout.alpha, 0.36) : 1;
      if (!hadNodes) warmup = warmupTicks;
      ticks = reducedMotion.matches ? 0 : cooldownTicks;
    }
    if (dragging?.node && !nodes.has(dragging.node.id)) dragging = undefined;
    if (!itemById(selected)) selected = undefined;
    setHover(itemById(hover?.id));
    showEmpty(bodies.length ? "" : "No graph records yet.");
    schedule();
  }

  function arrow(edge: Edge, control: Point, scale: number) {
    const tangent = Math.hypot(edge.to.x - control.x, edge.to.y - control.y) * 2;
    if (!tangent) return;
    const end = Math.max(0.5, 1 - graphRadius(edge.to.degree) / tangent);
    const tip = curvePoint(edge, control, end);
    const behind = curvePoint(edge, control, Math.max(0, end - 0.025));
    const angle = Math.atan2(tip.y - behind.y, tip.x - behind.x);
    const length = Math.min(arrowLength, tangent / 7);
    if (length * scale < 2) return;
    context.beginPath();
    context.moveTo(tip.x, tip.y);
    context.lineTo(tip.x - length * Math.cos(angle - 0.43), tip.y - length * Math.sin(angle - 0.43));
    context.lineTo(tip.x - length * Math.cos(angle + 0.43), tip.y - length * Math.sin(angle + 0.43));
    context.closePath();
    context.fillStyle = context.strokeStyle;
    context.fill();
  }

  function draw(now: number) {
    frame = 0;
    if (!visible) return;
    const animate = !paused && !reducedMotion.matches;
    if (!paused && width >= 80 && height >= 80 && warmup) {
      const deadline = performance.now() + 8;
      do {
        layout.step(bodies, edges.values(), dragging?.node);
        warmup--;
      } while (warmup && performance.now() < deadline);
    } else if (animate && ticks && width >= 80 && height >= 80) {
      layout.step(bodies, edges.values(), dragging?.node);
      ticks--;
    }
    if (warmup && reducedMotion.matches && !paused) { schedule(); return; }
    if (!initialFitDone && (!warmup || paused)) initialFitDone = fit(true);
    if (cameraMove) {
      const { from, to, started } = cameraMove;
      const progress = Math.min(1, Math.max(0, (now - started) / cameraDuration));
      const amount = 1 - (1 - progress) ** 3;
      camera = { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount,
        scale: from.scale + (to.scale - from.scale) * amount };
      if (progress === 1) cameraMove = undefined;
    }

    context.setTransform(pixels, 0, 0, pixels, 0, 0);
    context.clearRect(0, 0, width, height);
    context.translate(camera.x, camera.y);
    context.scale(camera.scale, camera.scale);
    const { scale } = camera;
    const left = -camera.x / scale;
    const right = (width - camera.x) / scale;
    const top = -camera.y / scale;
    const bottom = (height - camera.y) / scale;
    const labels: { node: Node; alpha: number; priority: number }[] = [];
    let effects = false;

    for (const edge of edges.values()) {
      const control = controlPoint(edge);
      const { from, to } = edge;
      if (Math.max(from.x, to.x, control.x) < left || Math.min(from.x, to.x, control.x) > right ||
        Math.max(from.y, to.y, control.y) < top || Math.min(from.y, to.y, control.y) > bottom) continue;
      const bright = edge.id === selected || edge === hover;
      const fresh = animate && now - edge.changed < effectDuration;
      effects ||= fresh;
      const added = animate ? Math.max(0, Math.min(1, (now - edge.added) / effectDuration)) : 1;
      context.globalAlpha = (bright ? 0.9 : edge.muted ? 0.16 : 0.4) * added;
      context.strokeStyle = bright || fresh ? nodeColor : linkColor;
      context.lineWidth = (bright ? 1.2 : 0.7) / scale;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.quadraticCurveTo(control.x, control.y, to.x, to.y);
      context.stroke();
      arrow(edge, control, scale);
    }

    for (const node of bodies) {
      const radius = graphRadius(node.degree);
      if (node.x + radius < left || node.x - radius > right || node.y + radius < top || node.y - radius > bottom) continue;
      const highlighted = node.id === selected || node === hover;
      const glow = node.id === selected ? 15 : 10;
      const alpha = node.muted ? 0.45 : 1;
      const fresh = animate ? Math.max(0, Math.min(1, 1 - (now - node.changed) / effectDuration)) : 0;
      effects ||= fresh > 0;
      context.save();
      context.globalAlpha = alpha * (animate ? Math.max(0, Math.min(1, (now - node.added) / effectDuration)) : 1);
      if (highlighted) {
        context.shadowColor = "#fff";
        context.shadowBlur = glow * pixels;
      }
      const color = typeColors[node.type ?? ""] ?? nodeColor;
      context.fillStyle = color;
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      context.fill();
      context.restore();
      if (fresh && !highlighted) {
        context.globalAlpha = alpha * fresh * 0.55;
        context.strokeStyle = color;
        context.lineWidth = 1 / scale;
        context.beginPath();
        context.arc(node.x, node.y, radius + (1 - fresh) * 9, 0, 2 * Math.PI);
        context.stroke();
      }
      const priority = highlighted ? 3 : hubs.has(node.id) ? 2 : 0;
      if (priority || scale >= 0.65) labels.push({ node, alpha, priority });
    }

    const drawn: { left: number; right: number; y: number }[] = [];
    for (const { node, alpha, priority } of labels.sort((a, b) => b.priority - a.priority)) {
      const fontSize = Math.max(10 / scale, graphRadius(node.degree) * 0.6);
      context.font = `${fontSize}px Inter, sans-serif`;
      const measure = context.measureText(node.name).width / 2;
      const y = node.y + graphRadius(node.degree) + 8;
      const box = { left: node.x - measure, right: node.x + measure, y };
      if (scale < 1 && priority < 3 && drawn.some(other => Math.abs(y - other.y) < fontSize &&
        other.left < box.right && other.right > box.left)) continue;
      drawn.push(box);
      context.textBaseline = "middle";
      context.textAlign = "center";
      context.globalAlpha = alpha;
      context.strokeStyle = "#121412";
      context.lineWidth = 2.5 / scale;
      context.strokeText(node.name, node.x, y);
      context.fillStyle = labelColor;
      context.fillText(node.name, node.x, y);
    }
    context.globalAlpha = 1;
    if (root.isConnected && (cameraMove || animate && (ticks > 0 || effects) || warmup > 0 && !paused && width >= 80 && height >= 80)) schedule();
  }

  function hit(x: number, y: number) {
    const point = { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale };
    for (let index = bodies.length - 1; index >= 0; index--) {
      const node = bodies[index];
      const dx = point.x - node.x;
      const dy = point.y - node.y;
      if (dx * dx + dy * dy <= graphRadius(node.degree) ** 2) return node;
    }
    let nearest: Edge | undefined;
    let threshold = 5 / camera.scale;
    for (const edge of edges.values()) {
      const control = controlPoint(edge);
      const xs = [edge.from.x, edge.to.x, control.x];
      const ys = [edge.from.y, edge.to.y, control.y];
      if (point.x < Math.min(...xs) - threshold || point.x > Math.max(...xs) + threshold ||
        point.y < Math.min(...ys) - threshold || point.y > Math.max(...ys) + threshold) continue;
      let previous: Point = edge.from;
      for (let sample = 1; sample <= 14; sample++) {
        const next = curvePoint(edge, control, sample / 14);
        const distance = distanceToSegment(point, previous, next);
        if (distance < threshold) { threshold = distance; nearest = edge; }
        previous = next;
      }
    }
    return nearest;
  }

  function setHover(item?: Node | Edge) {
    hover = item;
    const active = item ?? itemById(selected);
    const connections = active && !("from" in active) ? ` · ${active.degree} ${active.degree === 1 ? "connection" : "connections"}` : "";
    info.textContent = active ? `${active.name} · ${active.type ?? "Relationship"}${connections}` : "";
    canvas.style.cursor = item ? "pointer" : "grab";
    schedule();
  }

  function select(id?: string) { selected = id; setHover(); }

  function focus(id: string) {
    const record = itemById(id);
    if (!record) { select(); open(id); return; }
    const point = "from" in record ? curvePoint(record, controlPoint(record), 0.5) : record;
    const scale = Math.max(0.8, camera.scale);
    initialFitDone = true;
    select(id);
    moveCamera({ x: width / 2 - point.x * scale, y: height / 2 - point.y * scale, scale }, true);
    open(id);
  }

  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    initialFitDone = true;
    cameraMove = undefined;
    const item = hit(event.offsetX, event.offsetY);
    dragging = { point: { x: event.offsetX, y: event.offsetY }, node: item && !("from" in item) ? item : undefined, moved: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!dragging) { setHover(hit(event.offsetX, event.offsetY)); return; }
    const dx = event.offsetX - dragging.point.x;
    const dy = event.offsetY - dragging.point.y;
    if (!dragging.moved && Math.hypot(dx, dy) <= 3) return;
    dragging.moved = true;
    if (dragging.node) {
      dragging.node.x += dx / camera.scale;
      dragging.node.y += dy / camera.scale;
      layout.alpha = Math.max(layout.alpha, 0.24);
      ticks = Math.max(ticks, 40);
    } else { camera.x += dx; camera.y += dy; }
    dragging.point = { x: event.offsetX, y: event.offsetY };
    schedule();
  });
  canvas.addEventListener("pointerup", event => {
    if (dragging && !dragging.moved) {
      const item = hit(event.offsetX, event.offsetY);
      if (item) { select(item.id); open(item.id); }
    }
    dragging = undefined;
  });
  canvas.addEventListener("pointercancel", () => { dragging = undefined; });
  canvas.addEventListener("pointerleave", () => setHover());
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    zoom(Math.exp(-event.deltaY * 0.0017), event.offsetX, event.offsetY);
  }, { passive: false });
  canvas.addEventListener("keydown", event => {
    const offsets: Record<string, [number, number]> = { ArrowLeft: [26, 0], ArrowRight: [-26, 0], ArrowUp: [0, 26], ArrowDown: [0, -26] };
    const delta = offsets[event.key];
    if (delta) {
      event.preventDefault();
      initialFitDone = true;
      moveCamera({ ...camera, x: camera.x + delta[0], y: camera.y + delta[1] }, false);
    } else if (event.key === "+" || event.key === "-") {
      event.preventDefault();
      zoom(event.key === "+" ? 1.3 : 1 / 1.3, width / 2, height / 2);
    }
  });

  function showEmpty(message: string) {
    empty.textContent = message;
    empty.hidden = !message;
  }

  return {
    root, canvas, zoomControls, load, select, focus, showEmpty,
    connections(id: string) {
      const edge = edges.get(id);
      if (edge) return [edge.from, edge.to];
      return [...edges.values()].flatMap(edge => {
        const neighbor = edge.from.id === id ? edge.to : edge.to.id === id ? edge.from : undefined;
        return neighbor ? [{ id: edge.id, name: edge.name, neighbor }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name));
    },
    pause(value: boolean) { paused = value; schedule(); },
    close() { observer.disconnect(); cancelAnimationFrame(frame); },
  };
}

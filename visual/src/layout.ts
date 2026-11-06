"use strict";

/**
 * Where everything goes on the canvas. Two layouts:
 *  - constellation: people gather into clusters (by location or team), with a force simulation
 *    that runs a fixed number of steps from a fixed start, so the same data always draws the same picture;
 *  - org chart: top person, one column per direct report, and an indented outline under each column.
 */
import { forceSimulation, forceX, forceY, forceCollide, forceManyBody, forceLink, SimulationNodeDatum, randomLcg, scaleSqrt } from "d3";
import { Person } from "./model";

export interface Cluster {
    key: string;
    count: number;
    x: number;
    y: number;
    /** radius of the circle around the cluster's dots */
    radius: number;
}

interface ClusterNode extends SimulationNodeDatum { key: string; members: Person[]; R: number; }
interface DotNode extends SimulationNodeDatum { p: Person; cx: number; cy: number; r: number; }

export function dotRadius(people: Person[], base: number, hasSize: boolean): void {
    const max = Math.max(0, ...people.map(p => p.size ?? 0));
    const scale = scaleSqrt().domain([0, max || 1]).range([base * 0.55, base * 1.7]);
    for (const p of people) {
        p.r = hasSize && max > 0 ? scale(Math.max(0, p.size ?? 0)) : base * (p.children.length ? 1.25 : 1);
    }
}

export function layoutConstellation(people: Person[], clusterOf: (p: Person) => string): Cluster[] {
    // 1. one node per cluster, sized by how many people are in it
    const groups = new Map<string, Person[]>();
    for (const p of people) {
        const k = clusterOf(p);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
    }
    const avgR = people.reduce((s, p) => s + p.r, 0) / Math.max(1, people.length);
    const clusters: ClusterNode[] = Array.from(groups.entries())
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
        .map(([key, members], i, all) => {
            const angle = (i / all.length) * Math.PI * 2;
            const R = Math.sqrt(members.length) * (avgR * 2 + 14) * 0.62 + 18;
            return { key, members, R, x: Math.cos(angle) * 200 * Math.sqrt(all.length), y: Math.sin(angle) * 140 * Math.sqrt(all.length) };
        });

    const clusterSim = forceSimulation<ClusterNode>(clusters)
        .randomSource(randomLcg(7))
        .force("x", forceX<ClusterNode>(0).strength(0.06))
        .force("y", forceY<ClusterNode>(0).strength(0.09))     // a little flatter than tall: screens are wide
        .force("collide", forceCollide<ClusterNode>(d => d.R + 34).iterations(3))
        .stop();
    for (let i = 0; i < 300; i++) clusterSim.tick();

    // 2. people pulled towards their cluster's centre, pushed apart so dots don't overlap,
    //    and tugged gently towards their manager when the manager is in the same cluster
    const dots: DotNode[] = [];
    const nodeOf = new Map<Person, DotNode>();
    for (const c of clusters) {
        c.members.forEach((p, i) => {
            // sunflower spiral start: an even, repeatable spread
            const a = i * 2.39996, d = Math.sqrt(i + 0.5) * (avgR * 2 + 12) * 0.6;
            const n: DotNode = { p, cx: c.x, cy: c.y, r: p.r, x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
            dots.push(n);
            nodeOf.set(p, n);
        });
    }
    const links = people
        .filter(p => p.parent && clusterOf(p.parent) === clusterOf(p))
        .map(p => ({ source: nodeOf.get(p), target: nodeOf.get(p.parent) }));

    const sim = forceSimulation<DotNode>(dots)
        .randomSource(randomLcg(11))
        // a network look: people spread out around their manager like spokes, inside a loose cluster
        .force("x", forceX<DotNode>(d => d.cx).strength(0.07))
        .force("y", forceY<DotNode>(d => d.cy).strength(0.07))
        .force("charge", forceManyBody<DotNode>().strength(-22).distanceMax(90))
        .force("link", forceLink(links).distance(d => (d.source as DotNode).r + (d.target as DotNode).r + 16).strength(0.8))
        .force("collide", forceCollide<DotNode>(d => d.r + 4).iterations(2))
        .stop();
    for (let i = 0; i < 320; i++) sim.tick();

    for (const n of dots) { n.p.x = n.x; n.p.y = n.y; }

    return clusters.map(c => {
        const cx = c.members.reduce((s, p) => s + p.x, 0) / c.members.length;
        const cy = c.members.reduce((s, p) => s + p.y, 0) / c.members.length;
        const radius = Math.max(...c.members.map(p => Math.hypot(p.x - cx, p.y - cy) + p.r)) + 6;
        return { key: c.key, count: c.members.length, x: cx, y: cy, radius };
    });
}

// ------------------------------------------------------------------ org chart

export interface OrgItem {
    p: Person;
    kind: "top" | "head" | "row";
    x: number;
    y: number;
    w: number;
    h: number;
    level: number;
    expanded: boolean;
}

export interface OrgEdge { d: string; kind: "tree" | "outline"; }

export const ORG = { topW: 220, topH: 54, headW: 210, headH: 54, rowW: 196, rowH: 28, indent: 18, colGap: 28, vGap: 46 };

/**
 * Org chart: the top person, then one column per direct report with an outline of their team.
 * Columns wrap into rows to fit `maxWidth`, so text stays full size in a narrow visual.
 */
export function layoutOrg(roots: Person[], expanded: Set<string>, maxWidth: number): { items: OrgItem[]; edges: OrgEdge[]; width: number; height: number } {
    const items: OrgItem[] = [];
    const edges: OrgEdge[] = [];

    // One top person: draw them as the top card and their direct reports as columns.
    // Several top people: each becomes a column.
    const top = roots.length === 1 && roots[0].children.length ? roots[0] : null;
    const heads = top ? top.children : roots;

    // 1. build each column with x and y relative to the column's top-left corner
    interface Column { head: OrgItem; items: OrgItem[]; outline: { x1: number; y1: number; x2: number; y2: number }[]; w: number; h: number; }
    const columns: Column[] = heads.map(head => {
        const headItem: OrgItem = { p: head, kind: "head", x: 0, y: 0, w: ORG.headW, h: ORG.headH, level: 0, expanded: expanded.has(head.id) };
        const col: Column = { head: headItem, items: [headItem], outline: [], w: ORG.headW, h: ORG.headH };
        let y = ORG.headH + 10;
        const walk = (parent: Person, level: number, parentItem: OrgItem) => {
            for (const c of parent.children) {
                const item: OrgItem = {
                    p: c, kind: "row", x: 18 + (level - 1) * ORG.indent, y, w: ORG.rowW, h: ORG.rowH,
                    level, expanded: expanded.has(c.id)
                };
                col.items.push(item);
                // outline guide: down from the parent, across to this row
                const gx = parentItem.kind === "head" ? parentItem.x + 9 : parentItem.x + 12;
                col.outline.push({ x1: gx, y1: parentItem.y + parentItem.h, x2: item.x, y2: y + ORG.rowH / 2 });
                col.w = Math.max(col.w, item.x + ORG.rowW);
                y += ORG.rowH + 2;
                if (item.expanded && c.children.length) walk(c, level + 1, item);
            }
        };
        if (headItem.expanded) walk(head, 1, headItem);
        col.h = Math.max(col.h, y);
        return col;
    });

    // 2. pack columns into rows that fit the width
    const rows: Column[][] = [];
    let line: Column[] = [];
    let lineW = 0;
    for (const c of columns) {
        const need = (line.length ? ORG.colGap : 0) + c.w;
        if (line.length && lineW + need > maxWidth) { rows.push(line); line = []; lineW = 0; }
        lineW += (line.length ? ORG.colGap : 0) + c.w;
        line.push(c);
    }
    if (line.length) rows.push(line);
    const rowWidth = (r: Column[]) => r.reduce((s, c) => s + c.w, 0) + ORG.colGap * (r.length - 1);
    const width = Math.max(ORG.topW, ...rows.map(rowWidth));

    // 3. place rows one under another, each centred
    let rowTop = top ? ORG.topH + ORG.vGap : 0;
    const busYs: number[] = [];
    const headCentres: number[][] = [];
    for (const r of rows) {
        let x = (width - rowWidth(r)) / 2;
        const centres: number[] = [];
        for (const c of r) {
            for (const it of c.items) { it.x += x; it.y += rowTop; items.push(it); }
            for (const o of c.outline) {
                edges.push({ d: `M${o.x1 + x},${o.y1 + rowTop} V${o.y2 + rowTop} H${o.x2 + x}`, kind: "outline" });
            }
            centres.push(c.head.x + c.head.w / 2);
            x += c.w + ORG.colGap;
        }
        busYs.push(rowTop - ORG.vGap / 2);
        headCentres.push(centres);
        rowTop += Math.max(...r.map(c => c.h)) + ORG.vGap;
    }
    const height = rowTop - ORG.vGap;

    // 4. lines from the top person: down a trunk at the left, along a bar above each row, down to each head
    if (top) {
        const t: OrgItem = { p: top, kind: "top", x: width / 2 - ORG.topW / 2, y: 0, w: ORG.topW, h: ORG.topH, level: -1, expanded: true };
        items.unshift(t);
        const cx = t.x + t.w / 2;
        if (rows.length === 1) {
            for (const hx of headCentres[0]) edges.push({ d: `M${cx},${t.h} V${busYs[0]} H${hx} V${busYs[0] + ORG.vGap / 2}`, kind: "tree" });
        } else {
            const trunkX = -14;
            edges.push({ d: `M${cx},${t.h} V${busYs[0]} H${trunkX} V${busYs[busYs.length - 1]}`, kind: "tree" });
            busYs.forEach((by, i) => {
                const right = Math.max(...headCentres[i]);
                edges.push({ d: `M${trunkX},${by} H${right}`, kind: "tree" });
                for (const hx of headCentres[i]) edges.push({ d: `M${hx},${by} V${by + ORG.vGap / 2}`, kind: "tree" });
            });
        }
    }
    return { items, edges, width, height };
}

// ------------------------------------------------------------------ reporting-line network

export const NET = { memberR: 7, leaderR: 10, hubR: 14, gap: 3 };

/** A group drawn as one cluster: a leader (or hub) in the middle, their direct reports around them. */
export interface Blob {
    centre: Person;
    members: Person[];
    parent: Blob | null;
    isHub: boolean;
    x: number;
    y: number;
    R: number;
}

interface BlobNode extends SimulationNodeDatum { b: Blob; hx: number; hy: number; }


/**
 * Reporting-line network: the top person in the middle, a line to each person who manages managers (a hub),
 * and a line from each hub to the teams under them. Each team is a cluster: the team lead in the centre and
 * their reports around them. Deterministic: radial start positions, a seeded force step to remove overlaps.
 */
export function layoutNetwork(people: Person[], roots: Person[]): { blobs: Blob[]; edges: [Blob, Blob][] } {
    const blobOf = new Map<Person, Blob>();
    const blobs: Blob[] = [];
    const area = Math.pow(NET.memberR * 2 + NET.gap, 2);

    const make = (p: Person, parent: Blob | null): Blob => {
        const members = p.children.filter(c => !c.children.length);
        const isHub = p.children.some(c => c.children.length > 0) || parent === null;
        const rc = isHub ? NET.hubR : NET.leaderR;
        const r0 = rc + NET.memberR + NET.gap;
        const R = members.length ? Math.sqrt(r0 * r0 + members.length * area / Math.PI) + NET.memberR : rc + 4;
        const b: Blob = { centre: p, members, parent, isHub, x: 0, y: 0, R };
        blobs.push(b);
        blobOf.set(p, b);
        for (const c of p.children) if (c.children.length) make(c, b);
        return b;
    };
    const tops = roots.map(r => make(r, null));

    // 1. bottom up: how much room each blob needs with everything under it (its "reach").
    //    A hub's child blobs sit on a ring around it; the ring is made big enough for them to fit side by side.
    const kidsOf = (b: Blob) => blobs.filter(x => x.parent === b);
    const reach = new Map<Blob, number>();
    const ring = new Map<Blob, number>();
    const span = new Map<Blob, number>();
    const measure = (b: Blob): number => {
        const kids = kidsOf(b);
        if (!kids.length) { reach.set(b, b.R); return b.R; }
        kids.forEach(measure);
        const arcNeed = kids.reduce((s, k) => s + 2 * reach.get(k) + 12, 0);
        const maxKid = Math.max(...kids.map(k => reach.get(k)));
        const available = b.parent ? Math.PI * 1.85 : Math.PI * 2;     // a child hub fans away from its parent
        const r = Math.max(b.R + maxKid + 46, arcNeed / available);
        ring.set(b, r);
        span.set(b, Math.min(available, arcNeed / r));
        const v = r + maxKid;
        reach.set(b, v);
        return v;
    };
    tops.forEach(measure);

    // 2. top down: place each blob's children around it, centred on the direction away from its parent
    const place = (b: Blob, outward: number) => {
        const kids = kidsOf(b);
        if (!kids.length) return;
        const r = ring.get(b), sp = span.get(b);
        const total = kids.reduce((s, k) => s + 2 * reach.get(k) + 12, 0);
        let a = b.parent ? outward - sp / 2 : -Math.PI / 2;
        for (const k of kids) {
            const share = sp * (2 * reach.get(k) + 12) / total;
            const ang = a + share / 2;
            k.x = b.x + Math.cos(ang) * r;
            k.y = b.y + Math.sin(ang) * r;
            place(k, ang);
            a += share;
        }
    };
    let offset = 0;
    for (const t of tops) {               // several top people: side by side
        t.x = offset + reach.get(t); t.y = 0;
        place(t, 0);
        offset += 2 * reach.get(t) + 60;
    }

    // 3. a gentle pass to remove any remaining overlap, keeping the shape
    const nodes: BlobNode[] = blobs.map(b => ({ b, x: b.x, y: b.y, hx: b.x, hy: b.y }));
    if (tops.length === 1) { nodes[0].fx = tops[0].x; nodes[0].fy = tops[0].y; }
    const sim = forceSimulation<BlobNode>(nodes)
        .randomSource(randomLcg(5))
        .force("home-x", forceX<BlobNode>(d => d.hx).strength(0.3))
        .force("home-y", forceY<BlobNode>(d => d.hy).strength(0.3))
        .force("collide", forceCollide<BlobNode>(d => d.b.R + 20).iterations(3))
        .stop();
    for (let i = 0; i < 120; i++) sim.tick();
    for (const n of nodes) { n.b.x = n.x; n.b.y = n.y; }

    // people: centre of each blob, members on a sunflower spiral around it
    for (const b of blobs) {
        const rc = b.isHub ? NET.hubR : NET.leaderR;
        b.centre.x = b.x; b.centre.y = b.y; b.centre.r = rc;
        const r0 = rc + NET.memberR + NET.gap;
        b.members.forEach((m, i) => {
            const d = Math.sqrt(r0 * r0 + i * area / Math.PI);
            const ang = i * 2.39996 - Math.PI / 2;
            m.x = b.x + Math.cos(ang) * d;
            m.y = b.y + Math.sin(ang) * d;
            m.r = NET.memberR;
        });
    }
    // anyone not reached (for example a cycle broken in the model) sits at the edge, not at 0,0
    for (const p of people) if (!blobOf.has(p) && !p.parent) { p.x = 0; p.y = 0; p.r = NET.memberR; }

    return { blobs, edges: blobs.filter(b => b.parent).map(b => [b.parent, b] as [Blob, Blob]) };
}

// ------------------------------------------------------------------ org chart: one manager at a time

export const DEPT = { focusW: 250, focusH: 56, cardW: 210, cardH: 48, cellW: 160, cellH: 40, cellGap: 8, pad: 10, head: 26, colGap: 24, vGap: 40 };

export interface DeptCard { p: Person; kind: "focus" | "child" | "cell"; x: number; y: number; w: number; h: number; canOpen: boolean; }
export interface DeptBox { leader: Person; label: string; count: number; open: number; x: number; y: number; w: number; h: number; }

/**
 * The org chart for one person (the focus): their card, a card for each direct report, and under each report who
 * leads a team, a box with a card per team member. A report who manages managers gets an "open" button instead,
 * which makes them the focus. Blocks wrap into rows to fit the width.
 */
export function layoutDept(focus: Person, maxWidth: number, unitOf: (p: Person) => string, keep: (p: Person) => boolean = () => true):
    { cards: DeptCard[]; boxes: DeptBox[]; edges: string[]; width: number; height: number } {
    const cards: DeptCard[] = [];
    const boxes: DeptBox[] = [];
    const edges: string[] = [];

    interface Block { card: DeptCard; box: DeptBox | null; cells: DeptCard[]; w: number; h: number; }
    // `keep` limits the chart to some people (for example a selection): other reports and team members are left out
    const blocks: Block[] = focus.children.filter(keep).map(c => {
        const leaves = c.children.length > 0 && c.children.every(g => !g.children.length);
        const members = c.children.filter(keep);
        const card: DeptCard = { p: c, kind: "child", x: 0, y: 0, w: DEPT.cardW, h: DEPT.cardH, canOpen: c.children.length > 0 && !leaves };
        if (!leaves || !members.length) return { card, box: null, cells: [], w: DEPT.cardW, h: DEPT.cardH };
        const n = members.length;
        const cols = Math.min(n, n > 8 ? 3 : 2);
        const rows = Math.ceil(n / cols);
        const bw = DEPT.pad * 2 + cols * DEPT.cellW + (cols - 1) * DEPT.cellGap;
        const bh = DEPT.head + DEPT.pad + rows * DEPT.cellH + (rows - 1) * DEPT.cellGap;
        const by = DEPT.cardH + 14;
        const box: DeptBox = {
            leader: c, label: unitOf(c) || c.name, count: n, open: members.filter(g => g.isOpenRole).length,
            x: 0, y: by, w: bw, h: bh
        };
        const cells = members.map((g, i) => ({
            p: g, kind: "cell" as const, canOpen: false, w: DEPT.cellW, h: DEPT.cellH,
            x: DEPT.pad + (i % cols) * (DEPT.cellW + DEPT.cellGap),
            y: by + DEPT.head + Math.floor(i / cols) * (DEPT.cellH + DEPT.cellGap)
        }));
        const w = Math.max(DEPT.cardW, bw);
        card.x = (w - DEPT.cardW) / 2;
        return { card, box, cells, w, h: by + bh };
    });

    // wrap blocks into rows
    const rows: Block[][] = [];
    let line: Block[] = [], lineW = 0;
    for (const b of blocks) {
        const need = (line.length ? DEPT.colGap : 0) + b.w;
        if (line.length && lineW + need > maxWidth) { rows.push(line); line = []; lineW = 0; }
        lineW += (line.length ? DEPT.colGap : 0) + b.w;
        line.push(b);
    }
    if (line.length) rows.push(line);
    const rowW = (r: Block[]) => r.reduce((s, b) => s + b.w, 0) + DEPT.colGap * (r.length - 1);
    const width = Math.max(DEPT.focusW, ...rows.map(rowW));

    const f: DeptCard = { p: focus, kind: "focus", x: width / 2 - DEPT.focusW / 2, y: 0, w: DEPT.focusW, h: DEPT.focusH, canOpen: false };
    cards.push(f);
    const fx = f.x + f.w / 2;

    let top = DEPT.focusH + DEPT.vGap;
    const trunkX = -14;
    const buses: number[] = [];
    rows.forEach((r, ri) => {
        let x = (width - rowW(r)) / 2;
        const bus = top - DEPT.vGap / 2;
        buses.push(bus);
        const centres: number[] = [];
        for (const b of r) {
            b.card.x += x; b.card.y += top;
            cards.push(b.card);
            centres.push(b.card.x + b.card.w / 2);
            if (b.box) {
                b.box.x = x + (b.w - b.box.w) / 2; b.box.y += top;
                boxes.push(b.box);
                for (const c of b.cells) { c.x += b.box.x; c.y = c.y + top; cards.push(c); }
                edges.push(`M${b.card.x + b.card.w / 2},${b.card.y + b.card.h} V${b.box.y}`);
            }
            x += b.w + DEPT.colGap;
        }
        if (!r.length) return;
        if (rows.length === 1) {
            for (const cx of centres) edges.push(`M${fx},${DEPT.focusH} V${bus} H${cx} V${top}`);
        } else {
            if (ri === 0) edges.push(`M${fx},${DEPT.focusH} V${bus} H${trunkX}`);
            edges.push(`M${trunkX},${bus} H${Math.max(...centres)}`);
            for (const cx of centres) edges.push(`M${cx},${bus} V${top}`);
        }
        top += Math.max(...r.map(b => b.h)) + DEPT.vGap;
    });
    if (rows.length > 1) edges.push(`M${trunkX},${buses[0]} V${buses[buses.length - 1]}`);
    return { cards, boxes, edges, width, height: top - DEPT.vGap };
}

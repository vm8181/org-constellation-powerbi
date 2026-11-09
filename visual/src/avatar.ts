/*
 *  Small illustrated faces for people, drawn in SVG.
 *  Every face is made from the person's ID (skin tone, hair style, hair colour, beard),
 *  so the same person always looks the same. No photos and nothing loaded from the internet.
 *  Drawn in a unit circle (radius 1); the caller scales it to the dot's size.
 */
import { Selection } from "d3";

const SKIN = ["#F6D7C3", "#EDC3A3", "#DDA97F", "#C98C62", "#A86D4A", "#83502F"];
const HAIR = ["#2A1E17", "#3A2A20", "#58392A", "#1E1E24", "#8A5F37", "#B48552", "#C9C2B8"];

function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** hair drawn behind the head (long hair) */
const BACK: Record<number, string> = {
    1: "M-0.47 0.42 Q-0.6 -0.62 0 -0.6 Q0.6 -0.62 0.47 0.42 Q0.2 0.3 0 0.3 Q-0.2 0.3 -0.47 0.42Z",
};
/** hair drawn over the head */
const FRONT: Record<number, string> = {
    0: "M-0.38 -0.06 Q-0.44 -0.6 0 -0.58 Q0.44 -0.6 0.38 -0.06 Q0.33 -0.34 0 -0.36 Q-0.33 -0.34 -0.38 -0.06Z",
    1: "M-0.39 0.02 Q-0.45 -0.6 0 -0.58 Q0.45 -0.6 0.39 0.02 Q0.3 -0.3 0.05 -0.34 Q-0.15 -0.22 -0.39 0.02Z",
    2: "M-0.37 -0.1 Q-0.42 -0.56 0 -0.55 Q0.42 -0.56 0.37 -0.1 Q0.3 -0.33 0 -0.34 Q-0.3 -0.33 -0.37 -0.1Z",
    4: "M-0.36 -0.16 Q-0.36 -0.52 0 -0.52 Q0.36 -0.52 0.36 -0.16 Q0.3 -0.38 0 -0.39 Q-0.3 -0.38 -0.36 -0.16Z",
    5: "M-0.38 -0.02 Q-0.46 -0.58 -0.02 -0.58 Q0.46 -0.6 0.39 -0.12 Q0.2 -0.4 -0.12 -0.3 Q-0.28 -0.2 -0.38 -0.02Z",
};

/** Append one face per element to `g` (a selection of groups already placed and scaled). */
export function appendFaces<D>(g: Selection<SVGGElement, D, SVGGElement | null, unknown>, idOf: (d: D) => string, clipId: string): void {
    // the clip stays a circle of radius 0.9; the drawing inside is enlarged so the face fills it
    const face = g.append("g").classed("oc-face", true).attr("clip-path", `url(#${clipId})`)
        .append("g").attr("transform", "translate(0,0.1) scale(1.32)");
    face.each(function (d) {
        const h = hash(idOf(d));
        const skin = SKIN[h % SKIN.length];
        const hairColour = HAIR[(h >>> 3) % HAIR.length];
        const style = (h >>> 6) % 6;                 // 0 short, 1 long, 2 bun, 3 curly, 4 cropped, 5 side part
        const beard = style !== 1 && style !== 2 && ((h >>> 9) % 4 === 0);
        const el = this as SVGGElement;
        const add = (tag: string, attrs: Record<string, string | number>) => {
            const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const k in attrs) n.setAttribute(k, String(attrs[k]));
            el.appendChild(n);
            return n;
        };
        if (BACK[style]) add("path", { d: BACK[style], fill: hairColour });
        // shoulders in the team colour, then neck and head
        add("path", { class: "oc-shirt", d: "M-0.9 1.2 Q-0.86 0.46 0 0.43 Q0.86 0.46 0.9 1.2Z" });
        add("rect", { x: -0.12, y: 0.18, width: 0.24, height: 0.3, rx: 0.08, fill: skin, "fill-opacity": 0.85 });
        add("ellipse", { cx: 0, cy: -0.08, rx: 0.35, ry: 0.41, fill: skin });
        if (beard) add("path", { d: "M-0.32 0.02 Q-0.3 0.36 0 0.36 Q0.3 0.36 0.32 0.02 Q0.18 0.2 0 0.2 Q-0.18 0.2 -0.32 0.02Z", fill: hairColour });
        if (style === 3) {
            for (const [x, y, r] of [[-0.3, -0.3, 0.14], [-0.15, -0.46, 0.16], [0.05, -0.5, 0.16], [0.24, -0.42, 0.15], [0.34, -0.24, 0.12], [-0.36, -0.12, 0.1]]) {
                add("circle", { cx: x, cy: y, r, fill: hairColour });
            }
        } else if (FRONT[style] || style === 2) {
            add("path", { d: FRONT[style] || FRONT[2], fill: hairColour });
        }
        if (style === 2) add("circle", { cx: 0, cy: -0.6, r: 0.16, fill: hairColour });
        // eyes and a small smile
        add("circle", { class: "oc-eye", cx: -0.13, cy: -0.06, r: 0.035 });
        add("circle", { class: "oc-eye", cx: 0.13, cy: -0.06, r: 0.035 });
        add("path", { class: "oc-smile", d: "M-0.1 0.11 Q0 0.18 0.1 0.11" });
    });
}

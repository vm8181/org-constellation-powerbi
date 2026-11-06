"use strict";

/**
 * Turns the Power BI data view into people and a reporting tree.
 * One row = one person (or open role). Manager ID links each row to its manager.
 */
import powerbi from "powerbi-visuals-api";
import { valueFormatter } from "powerbi-visuals-utils-formattingutils";

import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import DataViewValueColumn = powerbi.DataViewValueColumn;
import ISelectionId = powerbi.visuals.ISelectionId;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISandboxExtendedColorPalette = powerbi.extensibility.ISandboxExtendedColorPalette;

export interface ExtraValue { name: string; value: string; }

export interface Person {
    id: string;
    managerId: string | null;
    name: string;
    title: string;
    team: string;
    /** the unit inside the team, for example "Platform" ("" when the field isn't used) */
    unit: string;
    location: string;
    status: string;
    isOpenRole: boolean;
    isOnLeave: boolean;
    size: number | null;
    sizeText: string;
    budget: number | null;
    startDate: Date | null;
    extras: ExtraValue[];
    selectionId: ISelectionId;
    /** false when another visual's selection leaves this person out (Power BI "highlight") */
    highlighted: boolean;
    color: string;
    parent: Person | null;
    children: Person[];
    depth: number;
    /** people under this person, at any level */
    reportCount: number;
    // positions, filled by the layouts
    x: number;
    y: number;
    r: number;
}

export interface OrgData {
    people: Person[];
    byId: Map<string, Person>;
    roots: Person[];
    teams: { name: string; color: string; count: number }[];
    sizeName: string;
    /** money is in rupees: show lakh and crore */
    rupees: boolean;
    hasLocation: boolean;
    hasUnit: boolean;
    hasSize: boolean;
    /** formats a total of the Size measure the way the measure is formatted */
    formatSize: (v: number) => string;
    /** true when another visual on the page has highlighted some people */
    hasHighlights: boolean;
}

const ROLE_NAMES = ["personId", "managerId", "name", "title", "team", "group", "location", "status", "startDate"] as const;

function text(v: powerbi.PrimitiveValue): string {
    return v === null || v === undefined ? "" : String(v).trim();
}

export function hasRequiredFields(dataView: DataView | undefined): boolean {
    const cats = dataView?.categorical?.categories ?? [];
    const has = (role: string) => cats.some(c => c.source.roles?.[role]);
    return has("personId") && has("managerId") && has("name");
}

export function buildOrg(dataView: DataView, host: IVisualHost, palette: ISandboxExtendedColorPalette): OrgData {
    const categorical = dataView.categorical;
    const cats = categorical.categories ?? [];
    const col: Partial<Record<typeof ROLE_NAMES[number], DataViewCategoryColumn>> = {};
    for (const role of ROLE_NAMES) {
        col[role] = cats.find(c => c.source.roles?.[role]);
    }
    const valueCols: DataViewValueColumn[] = categorical.values ? Array.from(categorical.values) : [];
    const sizeCol = valueCols.find(v => v.source.roles?.["size"]);
    const budgetCol = valueCols.find(v => v.source.roles?.["budget"]);
    const tooltipCols = valueCols.filter(v => v.source.roles?.["tooltips"] && !v.source.roles?.["size"] && !v.source.roles?.["budget"]);
    const rupees = !!sizeCol && /₹/.test(sizeCol.source.format ?? "");
    const highlightCol = valueCols.find(v => v.highlights);
    const sizeFormatter = sizeCol ? valueFormatter.create({ format: sizeCol.source.format, value: 0 }) : null;
    const tipFormatters = tooltipCols.map(c => valueFormatter.create({ format: c.source.format }));

    const personCol = col.personId;
    const rowCount = personCol.values.length;
    const people: Person[] = [];
    const byId = new Map<string, Person>();

    for (let i = 0; i < rowCount; i++) {
        const id = text(personCol.values[i]);
        if (!id || byId.has(id)) continue;           // skip blanks and repeats (first one wins)
        const status = col.status ? text(col.status.values[i]) : "";
        const team = col.team ? text(col.team.values[i]) || "(No team)" : "(No team)";
        const sizeRaw = sizeCol ? sizeCol.values[i] : null;
        const size = typeof sizeRaw === "number" ? sizeRaw : null;
        const p: Person = {
            id,
            managerId: text(col.managerId?.values[i]) || null,
            name: text(col.name?.values[i]) || id,
            title: col.title ? text(col.title.values[i]) : "",
            team,
            unit: col.group ? text(col.group.values[i]) : "",
            location: col.location ? text(col.location.values[i]) || "(No location)" : "",
            status,
            isOpenRole: /open/i.test(status),
            isOnLeave: /leave/i.test(status),
            size,
            sizeText: size === null || !sizeFormatter ? "" : rupees ? inr(size) : sizeFormatter.format(size),
            budget: budgetCol && typeof budgetCol.values[i] === "number" ? budgetCol.values[i] as number : null,
            startDate: toDate(col.startDate?.values[i]),
            extras: tooltipCols.map((c, k) => ({
                name: c.source.displayName,
                value: c.values[i] === null || c.values[i] === undefined ? "" : tipFormatters[k].format(c.values[i])
            })),
            selectionId: host.createSelectionIdBuilder().withCategory(personCol, i).createSelectionId(),
            highlighted: highlightCol ? highlightCol.highlights[i] !== null && highlightCol.highlights[i] !== undefined : true,
            color: palette.isHighContrast ? palette.foreground.value : palette.getColor(team).value,
            parent: null,
            children: [],
            depth: 0,
            reportCount: 0,
            x: 0, y: 0, r: 0
        };
        people.push(p);
        byId.set(id, p);
    }

    // Link each person to their manager. A manager that isn't in the data, or a loop
    // (A reports to B reports to A), makes that person a top-level person instead.
    for (const p of people) {
        const m = p.managerId ? byId.get(p.managerId) : undefined;
        if (!m || m === p) continue;
        let cursor: Person | null = m;
        let loops = false;
        while (cursor) {
            if (cursor === p) { loops = true; break; }
            cursor = cursor.parent;
        }
        if (!loops) {
            p.parent = m;
            m.children.push(p);
        }
    }
    const roots = people.filter(p => !p.parent);

    // depth and number of reports, walking down from the top
    const stack: Person[] = [...roots];
    const order: Person[] = [];
    while (stack.length) {
        const p = stack.pop();
        order.push(p);
        for (const c of p.children) { c.depth = p.depth + 1; stack.push(c); }
    }
    for (let k = order.length - 1; k >= 0; k--) {
        const p = order[k];
        p.reportCount = p.children.reduce((s, c) => s + 1 + c.reportCount, 0);
    }
    for (const p of people) {
        p.children.sort((a, b) => b.reportCount - a.reportCount || a.name.localeCompare(b.name));
    }

    const teamMap = new Map<string, { name: string; color: string; count: number }>();
    for (const p of people) {
        const t = teamMap.get(p.team) ?? { name: p.team, color: p.color, count: 0 };
        t.count++;
        teamMap.set(p.team, t);
    }

    return {
        people,
        byId,
        roots,
        teams: Array.from(teamMap.values()).sort((a, b) => b.count - a.count),
        sizeName: sizeCol ? sizeCol.source.displayName : "",
        rupees,
        hasLocation: !!col.location,
        hasUnit: !!col.group,
        hasSize: !!sizeCol,
        // a total can be large, so let Power BI pick K / M / bn (for example ₹84.8M)
        formatSize: (v: number) => !sizeCol ? String(v) : rupees ? inr(v)
            : valueFormatter.create({ format: sizeCol.source.format, value: v, precision: 1 }).format(v),
        hasHighlights: !!highlightCol
    };
}

/** Everyone under a person, including the person. */
export function initials(name: string): string {
    const parts = name.replace(/^Open role.*$/i, "").split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function subtree(p: Person): Person[] {
    const out: Person[] = [];
    const stack = [p];
    while (stack.length) {
        const q = stack.pop();
        out.push(q);
        stack.push(...q.children);
    }
    return out;
}

/** Rupees the Indian way: ₹35.9 L (lakh = 100,000), ₹1.74 Cr (crore = 10 million). */
export function inr(v: number): string {
    const a = Math.abs(v), sign = v < 0 ? "-" : "";
    if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e9 ? 0 : 2)} Cr`;
    if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`;
    return `${sign}₹${Math.round(a).toLocaleString("en-IN")}`;
}

function toDate(v: powerbi.PrimitiveValue | undefined): Date | null {
    if (v === null || v === undefined || v === "") return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
}

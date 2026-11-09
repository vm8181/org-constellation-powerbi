"use strict";

/**
 * Org Constellation: an organisation shown two ways.
 *   Constellation - the reporting line as a network (top person in the middle, a cluster per team),
 *                   or everyone clustered by location or team.
 *   Org chart     - one manager at a time: their reports as cards, and each team as a box of people.
 * Search, team chips, lasso and click selection; selections cross-filter the report page.
 */
import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { select, Selection, zoom, ZoomBehavior, zoomIdentity, ZoomTransform, pointer, polygonContains, line, curveBasisClosed } from "d3";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

import { VisualSettings } from "./settings";
import { OrgData, Person, buildOrg, hasRequiredFields, subtree, initials, inr } from "./model";
import { appendFaces } from "./avatar";
import { Cluster, DeptCard, DeptBox, Blob, layoutConstellation, layoutNetwork, layoutDept, dotRadius } from "./layout";

type Div = Selection<HTMLDivElement, unknown, null, undefined>;
type G = Selection<SVGGElement, unknown, null, undefined>;
type View = "constellation" | "orgChart";

export class Visual implements IVisual {
    private host: IVisualHost;
    private events: IVisualEventService;
    private selectionManager: ISelectionManager;
    private settingsService = new FormattingSettingsService();
    private settings: VisualSettings;

    private root: Div;
    private toolbar: Div;
    private chips: Div;
    private stage: Div;
    private footer: Div;
    private pill: Div;
    private zoomLabel: Selection<HTMLSpanElement, unknown, null, undefined>;
    private landing: Div;
    private svg: Selection<SVGSVGElement, unknown, null, undefined>;
    private layer: G;
    private lassoPath: Selection<SVGPathElement, unknown, null, undefined>;
    private searchBox: Selection<HTMLInputElement, unknown, null, undefined>;
    private zoomer: ZoomBehavior<SVGSVGElement, unknown>;

    private data: OrgData | null = null;
    private dataKey = "";
    private view: View = "constellation";
    private viewSetByUser = false;
    private clusterBy = "reporting";
    private clusterSetByUser = false;
    private lassoOn = false;
    private justLassoed = false;
    private selected = new Set<string>();
    private focusTeam: string | null = null;
    private search = "";
    /** whose org chart is shown; null = the top of the organisation */
    private orgFocus: string | null = null;
    /** when the org chart was opened with a selection: show only these people (and their managers) */
    private orgOnly: Set<string> | null = null;
    private stageSize = "";
    private faceClip = "";
    private crumbs: Div;
    private tip: Div;
    private transforms: Record<View, ZoomTransform | null> = { constellation: null, orgChart: null };
    private clusters: Cluster[] = [];
    private deptCards: DeptCard[] = [];
    private width = 0;
    private height = 0;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.events = options.host.eventService;
        this.selectionManager = options.host.createSelectionManager();
        this.selectionManager.registerOnSelectCallback((ids: ISelectionId[]) => {
            // a bookmark or another visual changed the selection
            this.selected = new Set(this.peopleFor(ids).map(p => p.id));
            this.applyStyles();
        });

        this.root = select(options.element).append("div").classed("oc-root", true);
        this.buildToolbar();
        this.chips = this.root.append("div").classed("oc-chips", true);
        this.stage = this.root.append("div").classed("oc-stage", true);
        this.landing = this.root.append("div").classed("oc-landing", true).style("display", "none");
        this.landing.append("div").classed("oc-landing-title", true).text("Org Constellation");
        this.landing.append("div").text("Add Person ID, Manager ID, Name and Team. Location, Status and Size are optional.");
        this.footer = this.root.append("div").classed("oc-footer", true);
        this.tip = this.root.append("div").classed("oc-tip", true).attr("role", "tooltip").style("display", "none");

        this.svg = this.stage.append("svg").classed("oc-svg", true);
        this.crumbs = this.stage.append("div").classed("oc-crumbs", true);
        const zc = this.stage.append("div").classed("oc-zoom", true);
        zc.append("button").attr("title", "Zoom out").attr("aria-label", "Zoom out").text("−")
            .on("click", () => this.svg.transition().duration(200).call(this.zoomer.scaleBy, 1 / 1.3));
        this.zoomLabel = zc.append("span").classed("oc-zoom-pct", true).text("100%");
        zc.append("button").attr("title", "Zoom in").attr("aria-label", "Zoom in").text("+")
            .on("click", () => this.svg.transition().duration(200).call(this.zoomer.scaleBy, 1.3));
        // one round clip for every face (faces are drawn in a unit circle and scaled)
        this.faceClip = "oc-face-" + Array.from(window.crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16)).join("");
        this.svg.append("defs").append("clipPath").attr("id", this.faceClip).append("circle").attr("r", 0.9);
        this.layer = this.svg.append("g").classed("oc-layer", true);
        this.lassoPath = this.svg.append("path").classed("oc-lasso", true);

        this.zoomer = zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.08, 6])
            // same zoom speed with or without Ctrl (d3 normally speeds up Ctrl + wheel tenfold)
            .wheelDelta((event: WheelEvent) => -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002))
            // in the org chart the mouse wheel scrolls (Ctrl + wheel zooms); in the constellation it zooms
            .filter((event: Event) => !this.lassoOn && !(event as MouseEvent).button
                && !((event as MouseEvent).shiftKey && event.type !== "wheel" && this.view === "constellation")
                && !(event.type === "wheel" && this.view === "orgChart" && !(event as WheelEvent).ctrlKey))
            .on("zoom", (event) => {
                this.layer.attr("transform", event.transform.toString());
                this.transforms[this.view] = event.transform;
                this.zoomLabel?.text(`${Math.round(event.transform.k * 100)}%`);
                this.layer.classed("oc-zoomed-out", event.transform.k < 1.4);
                // labels grow more slowly than the picture, so zooming in doesn't make them huge
                // ...and shrink more slowly when zooming out, so they stay readable
                const k = event.transform.k;
                this.layer.style("--oc-label-scale", String(1 / Math.sqrt(k)));
            });
        this.svg.call(this.zoomer).on("dblclick.zoom", null);
        this.svg.on("wheel.scroll", (event: WheelEvent) => {
            if (this.view !== "orgChart" || event.ctrlKey) return;
            event.preventDefault();
            this.svg.call(this.zoomer.translateBy, -event.deltaX / (this.transforms.orgChart?.k ?? 1), -event.deltaY / (this.transforms.orgChart?.k ?? 1));
        });

        // empty-space click clears the selection; right-click opens the Power BI menu
        this.svg.on("click", (event: MouseEvent) => {
            if (this.justLassoed) { this.justLassoed = false; return; }
            if (event.target === this.svg.node()) this.setSelection([], false);
        });
        this.svg.on("contextmenu", (event: MouseEvent) => {
            if (event.target !== this.svg.node()) return;
            event.preventDefault();
            this.selectionManager.showContextMenu({}, { x: event.clientX, y: event.clientY });
        });
        this.setupLasso();
    }

    // ------------------------------------------------------------------ update

    public update(options: VisualUpdateOptions) {
        this.events.renderingStarted(options);
        try {
            const dv = options.dataViews?.[0];
            this.settings = this.settingsService.populateFormattingSettingsModel(VisualSettings, dv);
            this.width = options.viewport.width;
            this.height = options.viewport.height;

            if (!hasRequiredFields(dv)) {
                this.data = null;
                this.landing.style("display", null);
                this.toolbar.style("display", "none");
                this.chips.style("display", "none");
                this.stage.style("display", "none");
                this.footer.style("display", "none");
                this.events.renderingFinished(options);
                return;
            }
            this.landing.style("display", "none");
            this.stage.style("display", null);
            this.footer.style("display", null);
            this.toolbar.style("display", this.settings.view.showToolbar.value ? null : "none");
            this.chips.style("display", this.settings.view.showToolbar.value ? null : "none");
            this.root.style("--oc-font-size", `${this.settings.dots.labelSize.value}px`);

            if (!this.viewSetByUser) this.view = this.settings.view.defaultView.value.value as View;
            if (!this.clusterSetByUser) this.clusterBy = String(this.settings.view.clusterBy.value.value);

            const palette = this.host.colorPalette;
            this.data = buildOrg(dv, this.host, palette);
            this.root.classed("oc-high-contrast", palette.isHighContrast);
            dotRadius(this.data.people, this.settings.dots.dotSize.value, this.data.hasSize);

            // a different set of people (new filter or new data): start the views fresh
            const key = this.data.people.map(p => p.id).join("|");
            if (key !== this.dataKey) {
                this.dataKey = key;
                this.transforms = { constellation: null, orgChart: null };
                if (this.orgFocus && !this.data.byId.has(this.orgFocus)) this.orgFocus = null;
            }
            const known = this.peopleFor(this.selectionManager.getSelectionIds() as ISelectionId[]);
            this.selected = new Set(known.map(p => p.id));

            // the visual was resized (or a title or subtitle added): fit again, so nothing is cut off
            const size = `${this.stage.node().clientWidth}x${this.stage.node().clientHeight}`;
            if (size !== this.stageSize) {
                this.stageSize = size;
                this.transforms = { constellation: null, orgChart: null };
            }
            this.svg.attr("width", this.stage.node().clientWidth).attr("height", this.stage.node().clientHeight);
            this.renderToolbarState();
            this.renderChips();
            this.render();
            this.events.renderingFinished(options);
        } catch (e) {
            this.events.renderingFailed(options, String(e));
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.settingsService.buildFormattingModel(this.settings);
    }

    // ------------------------------------------------------------------ toolbar and chips

    private buildToolbar() {
        this.toolbar = this.root.append("div").classed("oc-toolbar", true);
        const views = this.toolbar.append("div").classed("oc-seg", true).attr("role", "group").attr("aria-label", "View");
        views.append("button").attr("data-view", "constellation").text("Constellation")
            .on("click", () => this.switchView("constellation"));
        views.append("button").attr("data-view", "orgChart").text("Org chart")
            .on("click", () => this.switchView("orgChart"));

        const clusters = this.toolbar.append("div").classed("oc-seg oc-cluster-seg", true).attr("role", "group").attr("aria-label", "Cluster by");
        clusters.append("button").attr("data-cluster", "reporting").text("Reporting line").on("click", () => this.switchCluster("reporting"));
        clusters.append("button").attr("data-cluster", "location").text("By location").on("click", () => this.switchCluster("location"));
        clusters.append("button").attr("data-cluster", "team").text("By team").on("click", () => this.switchCluster("team"));

        this.searchBox = this.toolbar.append("input").classed("oc-search", true)
            .attr("type", "search").attr("placeholder", "Find a person").attr("aria-label", "Find a person")
            .on("input", () => { this.search = this.searchBox.property("value").trim().toLowerCase(); this.onSearch(); });

        this.pill = this.toolbar.append("div").classed("oc-pill", true).attr("aria-live", "polite");
        const tools = this.toolbar.append("div").classed("oc-tools", true);
        tools.append("button").classed("oc-lasso-btn", true).attr("title", "Draw around dots to select them")
            .text("Lasso").on("click", () => { this.lassoOn = !this.lassoOn; this.renderToolbarState(); });
        tools.append("button").attr("title", "Fit everything in view").text("Fit").on("click", () => this.fit(true));
    }

    private renderToolbarState() {
        this.toolbar.selectAll<HTMLButtonElement, unknown>("[data-view]")
            .each((_, i, nodes) => {
                const b = nodes[i] as HTMLButtonElement;
                b.classList.toggle("on", b.dataset.view === this.view);
                b.setAttribute("aria-pressed", String(b.dataset.view === this.view));
            });
        const showCluster = this.view === "constellation";
        this.toolbar.select("[data-cluster='location']").style("display", this.data?.hasLocation ? null : "none");
        this.toolbar.select(".oc-cluster-seg").style("display", showCluster ? null : "none");
        this.toolbar.selectAll<HTMLButtonElement, unknown>("[data-cluster]").each((_, i, nodes) => {
            const b = nodes[i] as HTMLButtonElement;
            b.classList.toggle("on", b.dataset.cluster === this.effectiveCluster());
        });
        this.toolbar.select(".oc-lasso-btn")
            .classed("on", this.lassoOn)
            .style("display", this.view === "constellation" ? null : "none");
        this.stage.classed("oc-lasso-mode", this.lassoOn && this.view === "constellation");
    }

    private renderChips() {
        const teams = this.data?.teams ?? [];
        const chip = this.chips.selectAll<HTMLButtonElement, typeof teams[number]>("button.oc-chip")
            .data(teams, d => d.name)
            .join(enter => {
                const b = enter.append("button").classed("oc-chip", true);
                b.append("span").classed("oc-chip-dot", true);
                b.append("span").classed("oc-chip-name", true);
                b.append("span").classed("oc-chip-count", true);
                return b;
            });
        chip.select(".oc-chip-dot").style("background", d => d.color);
        chip.select(".oc-chip-name").text(d => d.name);
        chip.select(".oc-chip-count").text(d => d.count);
        chip.classed("on", d => this.focusTeam === d.name)
            .classed("dim", d => this.focusTeam !== null && this.focusTeam !== d.name)
            .attr("aria-pressed", d => String(this.focusTeam === d.name))
            .on("click", (_, d) => {
                this.focusTeam = this.focusTeam === d.name ? null : d.name;
                if (this.view === "orgChart") {
                    // in the org chart a team chip opens that team: the most senior person in it
                    const lead = this.focusTeam ? this.data.people.filter(p => p.team === d.name).sort((a, b) => a.depth - b.depth)[0] : null;
                    this.orgFocus = lead && lead.children.length ? lead.id : (lead?.parent?.id ?? null);
                    this.transforms.orgChart = null;
                    this.renderChips();
                    this.render();
                    return;
                }
                this.renderChips();
                this.applyStyles();
            });
    }

    private switchView(v: View) {
        this.view = v;
        this.viewSetByUser = true;
        if (v !== "constellation") this.lassoOn = false;
        if (v === "orgChart") this.focusOnSelection();
        this.renderToolbarState();
        this.render();
    }

    private switchCluster(c: string) {
        this.clusterBy = c;
        this.clusterSetByUser = true;
        this.transforms.constellation = null;
        this.renderToolbarState();
        this.render();
    }

    private effectiveCluster(): string {
        return this.clusterBy === "location" && !this.data?.hasLocation ? "reporting" : this.clusterBy;
    }

    // ------------------------------------------------------------------ drawing

    private render() {
        if (!this.data) return;
        this.layer.selectAll("*").remove();
        this.layer.classed("oc-org", this.view === "orgChart");
        this.crumbs.style("display", this.view === "orgChart" ? null : "none");
        if (this.view === "orgChart") this.drawOrg();
        else if (this.effectiveCluster() === "reporting") this.drawNetwork();
        else this.drawConstellation();
        this.applyStyles();
        const t = this.transforms[this.view];
        if (t) this.svg.call(this.zoomer.transform, t);
        else this.fit(false);
        this.updateFooter();
    }

    private drawConstellation() {
        const by = this.effectiveCluster();
        const people = this.data.people;
        this.clusters = layoutConstellation(people, p => by === "team" ? p.team : p.location);

        this.layer.append("g").classed("oc-halos", true)
            .selectAll("circle").data(this.clusters).join("circle")
            .attr("cx", d => d.x).attr("cy", d => d.y).attr("r", d => d.radius);

        if (this.settings.view.showLinks.value) {
            const sameCluster = (p: Person) => p.parent && (by === "team" ? p.parent.team === p.team : p.parent.location === p.location);
            this.layer.append("g").classed("oc-links", true)
                .selectAll("line").data(people.filter(sameCluster)).join("line")
                .attr("x1", d => d.x).attr("y1", d => d.y).attr("x2", d => d.parent.x).attr("y2", d => d.parent.y)
                .attr("stroke", d => d.color);
        }

        this.drawNodes(people, false);

        // names of managers, shown when zoomed in
        this.layer.append("g").classed("oc-names", true)
            .selectAll("text").data(people.filter(p => p.children.length)).join("text")
            .attr("x", d => d.x + d.r + 3).attr("y", d => d.y + 3).text(d => d.name);

        if (this.settings.view.showClusterLabels.value) {
            const lab = this.layer.append("g").classed("oc-cluster-labels", true)
                .selectAll("text").data(this.clusters).join("text")
                .attr("x", d => d.x).attr("y", d => d.y - d.radius - 8).attr("text-anchor", "middle");
            lab.append("tspan").classed("oc-cl-name", true).text(d => d.key);
            lab.append("tspan").classed("oc-cl-count", true).attr("dx", 6).text(d => String(d.count));
        }
    }

    /** People as round avatars: a coloured ring, initials inside. Shared by both constellation modes. */
    private drawNodes(people: Person[], initialsOn: boolean) {
        const node = this.layer.append("g").classed("oc-dots", true)
            .selectAll<SVGGElement, Person>("g").data(people, d => d.id).join("g")
            .attr("class", d => "oc-node" + (d.isOpenRole ? " open" : "") + (d.isOnLeave ? " leave" : "")
                + (d.children.length ? " mgr" : "") + (initialsOn && !d.parent ? " top" : ""))
            .attr("transform", d => `translate(${d.x},${d.y})`)
            .attr("tabindex", 0)
            .attr("aria-label", d => `${d.name}, ${d.title}, ${d.team}`)
            .style("--oc-c", d => d.color);
        node.append("circle").classed("oc-dot", true).attr("r", d => d.r);
        // an illustrated face for each person (open roles stay an empty dashed circle)
        const faces = node.filter(d => !d.isOpenRole).append("g").attr("transform", d => `scale(${d.r})`);
        appendFaces(faces, d => d.id, this.faceClip);
        void initialsOn;
        this.bindPointer(node, d => [d]);
    }

    private drawNetwork() {
        const { blobs, edges } = layoutNetwork(this.data.people, this.data.roots);
        this.clusters = [];
        this.layer.append("g").classed("oc-halos net", true)
            .selectAll("circle").data(blobs.filter(b => b.members.length)).join("circle")
            .attr("cx", d => d.x).attr("cy", d => d.y).attr("r", d => d.R + 4)
            .style("--oc-c", d => d.centre.color);
        this.layer.append("g").classed("oc-net-links", true)
            .selectAll("line").data(edges).join("line")
            .attr("x1", d => d[0].x).attr("y1", d => d[0].y).attr("x2", d => d[1].x).attr("y2", d => d[1].y);
        this.drawNodes(this.data.people, true);

        if (!this.settings.view.showClusterLabels.value) return;
        // team label on the outside of each cluster, away from the line that joins it to its manager
        const label = (b: Blob) => {
            const unit = this.data.hasUnit ? b.centre.unit : "";
            return b.isHub ? b.centre.name : (unit || b.centre.name);
        };
        const lab = this.layer.append("g").classed("oc-cluster-labels net", true)
            .selectAll<SVGTextElement, Blob>("text").data(blobs).join("text")
            .each((b, i, nodes) => {
                const t = select(nodes[i]);
                if (b.isHub) {
                    t.attr("x", b.x).attr("y", b.y + (b.members.length ? b.R + 16 : b.centre.r + 14)).attr("text-anchor", "middle");
                    if (b.members.length) t.attr("y", b.y - b.R - 10);
                    return;
                }
                // on the far side of its own cluster from its manager, so it never sits on the joining line
                const below = b.parent ? b.y >= b.parent.y : false;
                t.attr("x", b.x).attr("y", below ? b.y + b.R + 14 : b.y - b.R - 6).attr("text-anchor", "middle");
            })
            .classed("hub", d => d.isHub);
        lab.append("tspan").classed("oc-cl-name", true).text(label);
        lab.filter(d => !d.isHub).append("tspan").classed("oc-cl-count", true).attr("dx", 5).text(d => String(d.members.length + 1));
    }

    private drawOrg() {
        const root = this.data.roots.length === 1 ? this.data.roots[0] : null;
        const focus = (this.orgFocus && this.data.byId.get(this.orgFocus)) || root;
        this.renderCrumbs(focus);
        if (!focus) {
            this.layer.append("text").classed("oc-empty", true).text("Several top people: pick one with search or a team chip");
            return;
        }
        const avail = Math.max(260, (this.stage.node().clientWidth || this.width) - 48);
        // with a selection, keep the selected people and the managers above them
        let keep: ((p: Person) => boolean) | undefined;
        if (this.orgOnly) {
            const shown = new Set<string>();
            for (const id of this.orgOnly) for (let q = this.data.byId.get(id); q; q = q.parent) shown.add(q.id);
            keep = p => shown.has(p.id) || (this.orgOnly.has(p.id));
        }
        const { cards, boxes, edges } = layoutDept(focus, avail, p => this.data.hasUnit ? p.unit : "", keep);
        this.deptCards = cards;

        this.layer.append("g").classed("oc-edges", true)
            .selectAll("path").data(edges).join("path").attr("class", "oc-edge").attr("d", d => d);

        const box = this.layer.append("g").classed("oc-boxes", true)
            .selectAll<SVGGElement, DeptBox>("g").data(boxes).join("g").classed("oc-box", true)
            .attr("transform", d => `translate(${d.x},${d.y})`).style("--oc-c", d => d.leader.color);
        box.append("rect").attr("width", d => d.w).attr("height", d => d.h).attr("rx", 10);
        const head = box.append("g").classed("oc-box-head", true).attr("role", "button").attr("tabindex", 0)
            .attr("aria-label", d => `Select ${d.label}`);
        head.append("circle").attr("cx", 14).attr("cy", 14).attr("r", 4);
        head.append("text").attr("x", 24).attr("y", 18).text(d => d.label)
            .append("tspan").classed("oc-box-count", true).attr("dx", 6).text(d => String(d.count));
        box.filter(d => d.open > 0).append("text").classed("oc-box-open", true)
            .attr("x", d => d.w - 10).attr("y", 18).attr("text-anchor", "end").text(d => `${d.open} open`);
        head.on("click", (event: MouseEvent, d) => { event.stopPropagation(); this.setSelection(d.leader.children, event.ctrlKey || event.metaKey); });

        const card = this.layer.append("g").classed("oc-cards", true)
            .selectAll<SVGGElement, DeptCard>("g").data(cards, d => d.p.id).join("g")
            .attr("class", d => `oc-card ${d.kind}` + (d.p.isOpenRole ? " open" : "") + (d.p.isOnLeave ? " leave" : ""))
            .attr("transform", d => `translate(${d.x},${d.y})`)
            .attr("tabindex", 0)
            .attr("aria-label", d => `${d.p.name}, ${d.p.title}`)
            .style("--oc-c", d => d.p.color);
        card.append("rect").classed("oc-card-bg", true).attr("width", d => d.w).attr("height", d => d.h).attr("rx", d => d.kind === "cell" ? 7 : 9);
        const av = card.append("g").classed("oc-avatar", true).attr("transform", d => `translate(${d.h / 2},${d.h / 2})`);
        av.append("circle").attr("r", d => d.kind === "cell" ? 12 : 16);
        const cardFaces = av.filter(d => !d.p.isOpenRole).append("g").attr("transform", d => `scale(${d.kind === "cell" ? 12 : 16})`);
        appendFaces(cardFaces, d => d.p.id, this.faceClip);
        card.append("text").classed("oc-card-name", true)
            .attr("x", d => d.h + 2).attr("y", d => d.kind === "cell" ? 16 : 22)
            .text(d => trim(d.p.isOpenRole ? "Open role" : d.p.name, d.kind === "cell" ? 18 : 22));
        card.append("text").classed("oc-card-title", true)
            .attr("x", d => d.h + 2).attr("y", d => d.kind === "cell" ? 30 : 39)
            .text(d => trim(d.p.title + (d.p.isOnLeave ? " · on leave" : ""), d.kind === "cell" ? 21 : d.canOpen ? 18 : 27));
        card.filter(d => d.kind !== "cell" && d.p.reportCount > 0).append("text").classed("oc-card-count", true)
            .attr("x", d => d.w - 10).attr("y", 22).attr("text-anchor", "end").text(d => String(d.p.reportCount));

        // a report who manages managers: "Open" makes them the focus
        const open = card.filter(d => d.canOpen).append("g").classed("oc-open-btn", true)
            .attr("transform", d => `translate(${d.w - 58},${d.h - 20})`).attr("role", "button")
            .attr("aria-label", d => `Open ${d.p.name}'s team`)
            .on("click", (event: MouseEvent, d) => { event.stopPropagation(); this.openFocus(d.p.id); });
        open.append("rect").attr("width", 50).attr("height", 16).attr("rx", 8);
        open.append("text").attr("x", 25).attr("y", 11.5).attr("text-anchor", "middle").text("Open ›");

        // selecting a manager selects everyone under them (their reporting line)
        this.bindPointer(card, d => d.kind === "cell" ? [d.p] : subtree(d.p));
        card.on("dblclick", (event: MouseEvent, d) => { if (d.p.children.length) { event.stopPropagation(); this.openFocus(d.p.id); } });
    }

    /**
     * Opening the org chart with people selected: show only them, starting at the lowest manager they all share,
     * so a lasso around one director's teams opens that director's chart with just those teams.
     */
    private focusOnSelection() {
        const chosen = this.data?.people.filter(p => this.selected.has(p.id)) ?? [];
        if (!chosen.length) { this.orgOnly = null; return; }
        const chain = (p: Person) => { const c: Person[] = []; for (let q = p; q; q = q.parent) c.unshift(q); return c; };
        let common = chain(chosen[0]);
        for (const p of chosen.slice(1)) {
            const c = chain(p);
            let i = 0;
            while (i < common.length && i < c.length && common[i] === c[i]) i++;
            common = common.slice(0, i);
        }
        let focus = common[common.length - 1] ?? null;
        // a team lead or a single person: show them inside their manager's chart, so their team box appears
        if (focus && (!focus.children.length || focus.children.every(c => !c.children.length))) focus = focus.parent ?? focus;
        this.orgOnly = new Set(chosen.map(p => p.id));
        this.orgFocus = focus ? focus.id : null;
        this.transforms.orgChart = null;
    }

    private openFocus(id: string | null) {
        this.orgFocus = id;
        this.transforms.orgChart = null;
        this.render();
    }

    /** "Ishaan Chopra › Farhan Gupta" above the org chart, to go back up. */
    private renderCrumbs(focus: Person | null) {
        const chain: Person[] = [];
        for (let q = focus; q; q = q.parent) chain.unshift(q);
        this.crumbs.selectAll("*").remove();
        if (chain.length > 1) {
            chain.forEach((d, i) => this.crumbs.append("button").classed("crumb", true).classed("on", i === chain.length - 1)
                .text(d.name).on("click", () => this.openFocus(d.id)));
        }
        if (this.orgOnly) {
            const n = this.orgOnly.size;
            this.crumbs.append("span").classed("oc-only", true).text(`Showing ${n} selected ${n === 1 ? "person" : "people"}`);
            this.crumbs.append("button").classed("oc-only-btn", true).text("Show everyone")
                .on("click", () => { this.orgOnly = null; this.transforms.orgChart = null; this.render(); });
        }
    }

    /** Click, ctrl-click, keyboard, tooltip and context menu for dots or cards. */
    private bindPointer<E extends SVGElement, D>(sel: Selection<E, D, SVGGElement, unknown>, peopleOf: (d: D) => Person[]) {
        const personOf = (d: D) => peopleOf(d)[0];
        sel.on("click", (e: Event, d: D) => {
            const event = e as MouseEvent;
            event.stopPropagation();
            this.setSelection(peopleOf(d), event.ctrlKey || event.metaKey);
        })
            .on("keydown", (e: Event, d: D) => {
                const event = e as KeyboardEvent;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    this.setSelection(peopleOf(d), event.ctrlKey || event.metaKey);
                }
            })
            .on("contextmenu", (e: Event, d: D) => {
                const event = e as MouseEvent;
                event.preventDefault();
                event.stopPropagation();
                this.selectionManager.showContextMenu(personOf(d).selectionId, { x: event.clientX, y: event.clientY });
            })
            .on("mouseover", (e: Event, d: D) => this.showTooltip(e as MouseEvent, personOf(d), false))
            .on("mousemove", (e: Event, d: D) => this.showTooltip(e as MouseEvent, personOf(d), true))
            .on("mouseout", () => this.tip.style("display", "none"));
    }

    /** The visual's own tooltip card: who, where, status, and the numbers that matter for this kind of person. */
    private showTooltip(event: MouseEvent, p: Person, move: boolean) {
        if (!move || this.tip.attr("data-id") !== p.id) this.fillTooltip(p);
        // place it next to the pointer, kept inside the visual
        const [x, y] = pointer(event, this.root.node());
        const box = this.root.node().getBoundingClientRect();
        const tw = this.tip.node().offsetWidth, th = this.tip.node().offsetHeight;
        let left = x + 16, top = y + 14;
        if (left + tw > box.width - 4) left = Math.max(4, x - tw - 16);
        if (top + th > box.height - 4) top = Math.max(4, box.height - th - 4);
        this.tip.style("left", `${left}px`).style("top", `${top}px`);
    }

    private fillTooltip(p: Person) {
        const t = this.tip.attr("data-id", p.id).style("display", null).style("--oc-c", p.color);
        t.selectAll("*").remove();
        const money = (v: number) => this.data.rupees ? inr(v) : this.data.formatSize(v);
        const perYear = this.data.rupees ? " a year" : "";

        // who
        const top = t.append("div").classed("oc-tip-top", true);
        top.append("div").classed("oc-tip-av", true).classed("open", p.isOpenRole).text(p.isOpenRole ? "?" : initials(p.name));
        const who = top.append("div");
        who.append("div").classed("oc-tip-name", true).text(p.isOpenRole ? "Open role" : p.name);
        const boss = p.parent ? (p.isOpenRole ? `hiring manager ${p.parent.name}` : `reports to ${p.parent.name}`) : "top of the organisation";
        who.append("div").classed("oc-tip-sub", true).text([p.title, boss].filter(Boolean).join(" · "));

        // where and status
        const chips = t.append("div").classed("oc-tip-chips", true);
        const team = chips.append("span").classed("oc-tip-chip", true);
        team.append("i");
        team.append("span").text(p.unit && p.unit !== p.team ? `${p.team} · ${p.unit}` : p.team);
        if (this.data.hasLocation && p.location) chips.append("span").classed("oc-tip-chip", true).text(`📍 ${p.location}`);
        const st = p.isOpenRole ? ["hire", "◌ Hiring"] : p.isOnLeave ? ["warn", "◐ On leave"] : p.status ? ["ok", `● ${p.status}`] : null;
        if (st) chips.append("span").classed(`oc-tip-chip ${st[0]}`, true).text(st[1]);

        const section = () => t.append("div").classed("oc-tip-sec", true);
        const stat = (parent: Div, k: string, v: string) => {
            const c = parent.append("div");
            c.append("div").classed("oc-tip-k", true).text(k);
            c.append("div").classed("oc-tip-v", true).text(v);
        };

        if (p.isOpenRole) {
            if (p.budget !== null && p.budget > 0) {
                const sec = section();
                stat(sec, "Budget", money(p.budget) + perYear);
                sec.append("div").classed("oc-tip-note", true).text("Not being spent until the role is filled");
            }
        } else {
            if (p.children.length) {
                const under = subtree(p).filter(q => q !== p);
                const sec = section().classed("oc-tip-grid", true);
                const direct = p.children.length;
                stat(sec, "Team", `${p.reportCount} ${p.reportCount === 1 ? "person" : "people"}`
                    + (direct !== p.reportCount ? ` (${direct} direct)` : ""));
                stat(sec, "Open roles", String(under.filter(q => q.isOpenRole).length));
                if (this.data.hasSize) stat(sec, "Team cost", money(under.reduce((s2, q) => s2 + (q.size ?? 0), 0)));
            }
            if (this.data.hasSize && p.size !== null) this.costSection(section(), p, money, perYear);
            if (p.startDate) {
                const sec = section();
                stat(sec, "With the company", tenure(p.startDate));
                sec.append("div").classed("oc-tip-note", true)
                    .text(`Joined ${p.startDate.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`);
            }
        }
        const extras = p.extras.filter(x => x.value !== "");
        if (extras.length) {
            const sec = section().classed("oc-tip-rows", true);
            for (const x of extras) {
                const r = sec.append("div");
                r.append("span").text(x.name);
                r.append("b").text(x.value);
            }
        }
        const foot = t.append("div").classed("oc-tip-foot", true);
        const teamClick = this.view === "orgChart" && p.children.length > 0;
        foot.append("kbd").text("Click");
        foot.append("span").text(teamClick ? " select the team · " : " select · ");
        foot.append("kbd").text("Ctrl+click");
        foot.append("span").text(" add to selection");
    }

    /** Cost, with a bar comparing it to the average for the same job title. */
    private costSection(sec: Div, p: Person, money: (v: number) => string, perYear: string) {
        sec.append("div").classed("oc-tip-k", true).text(p.children.length ? "Own cost" : (this.data.sizeName || "Cost"));
        sec.append("div").classed("oc-tip-v", true).text(money(p.size) + perYear);
        const peers = this.data.people.filter(q => q.title === p.title && !q.isOpenRole && q.size !== null && q.size > 0);
        if (peers.length < 3 || !p.title) return;
        const avg = peers.reduce((s2, q) => s2 + q.size, 0) / peers.length;
        const max = Math.max(...peers.map(q => q.size)) * 1.05;
        const bar = sec.append("div").classed("oc-tip-bar", true);
        bar.append("b").style("width", `${Math.min(100, p.size / max * 100)}%`);
        bar.append("s").style("left", `${Math.min(100, avg / max * 100)}%`);
        const diff = Math.round((p.size - avg) / avg * 100);
        const how = Math.abs(diff) < 1 ? "the same as" : `${Math.abs(diff)}% ${diff > 0 ? "above" : "below"}`;
        sec.append("div").classed("oc-tip-note", true).text(`${how} the average ${p.title} (${money(avg)})`);
    }

    // ------------------------------------------------------------------ selection

    private setSelection(people: Person[], add: boolean) {
        if (!this.host.hostCapabilities.allowInteractions) return;
        const ids = people.map(p => p.id);
        if (add) {
            const allIn = ids.every(id => this.selected.has(id));
            for (const id of ids) { if (allIn) this.selected.delete(id); else this.selected.add(id); }
        } else {
            const same = ids.length === this.selected.size && ids.every(id => this.selected.has(id));
            this.selected = same ? new Set() : new Set(ids);    // clicking the same thing again clears it
        }
        const chosen = this.data.people.filter(p => this.selected.has(p.id)).map(p => p.selectionId);
        if (chosen.length) this.selectionManager.select(chosen, false);
        else this.selectionManager.clear();
        this.applyStyles();
    }

    private peopleFor(ids: ISelectionId[]): Person[] {
        if (!this.data || !ids?.length) return [];
        return this.data.people.filter(p => ids.some(id => id.equals(p.selectionId)));
    }

    /** Dim, highlight and selection classes, without redrawing. */
    private applyStyles() {
        if (!this.data) return;
        const anySel = this.selected.size > 0;
        const match = (p: Person) => this.search.length > 1 && p.name.toLowerCase().includes(this.search);
        const outsideHighlight = (p: Person) => this.data.hasHighlights && !p.highlighted;
        // in an org chart already narrowed to the selection, the managers shown for context aren't faded
        const narrowed = this.view === "orgChart" && !!this.orgOnly;
        const dim = (p: Person) => (anySel && !narrowed && !this.selected.has(p.id)) || outsideHighlight(p)
            || (this.focusTeam !== null && p.team !== this.focusTeam);
        this.layer.selectAll<SVGGElement, Person>("g.oc-node")
            .classed("dim", dim).classed("sel", p => this.selected.has(p.id)).classed("match", match);
        this.layer.selectAll<SVGGElement, DeptCard>("g.oc-card")
            .classed("dim", d => dim(d.p)).classed("sel", d => this.selected.has(d.p.id)).classed("match", d => match(d.p));
        this.layer.selectAll<SVGTextElement, Person>(".oc-names text").classed("dim", dim);
        this.layer.selectAll<SVGLineElement, Person>(".oc-links line").classed("dim", dim);
        this.layer.selectAll<SVGGElement, DeptBox>("g.oc-box").classed("dim", d => d.leader.children.every(dim));
        this.updateFooter();
    }

    private updateFooter() {
        if (!this.data) return;
        const n = this.data.people.length;
        const sel = this.selected.size;
        const keys: [string, string][] = this.view === "constellation"
            ? [["Scroll", "zoom"], ["Drag", "move"], ["Shift+drag", "lasso"], ["Ctrl+click", "add"]]
            : [["Scroll", "move"], ["Ctrl+scroll", "zoom"], ["Click", "select a team"], ["Open ›", "go down a level"]];
        this.footer.selectAll("*").remove();
        this.footer.append("span").classed("oc-count", true).text(`${n} people`);
        for (const [k, v] of keys) {
            this.footer.append("kbd").text(k);
            this.footer.append("span").text(v);
        }
        const chosen = this.data.people.filter(p => this.selected.has(p.id));
        const cost = chosen.reduce((s, p) => s + (p.size ?? 0), 0);
        this.pill.classed("on", sel > 0)
            .text(sel ? `${sel} selected${this.data.hasSize ? `  ·  ${this.data.formatSize(cost)}` : ""}` : "");
    }

    // ------------------------------------------------------------------ search, fit, lasso

    private onSearch() {
        if (!this.data) return;
        const hit = this.search.length > 1 ? this.data.people.find(p => p.name.toLowerCase().includes(this.search)) : undefined;
        if (hit && this.view === "orgChart" && !this.deptCards.some(c => c.p === hit)) {
            // show the chart that contains the person: their manager's manager (or their manager, for a manager)
            const f = hit.children.length ? (hit.parent ?? hit) : (hit.parent?.parent ?? hit.parent ?? hit);
            this.openFocus(f.id);
        }
        this.applyStyles();
        if (!hit) return;
        let cx: number, cy: number;
        if (this.view === "constellation") { cx = hit.x; cy = hit.y; }
        else {
            const it = this.deptCards.find(i => i.p === hit);
            if (!it) return;
            cx = it.x + it.w / 2; cy = it.y + it.h / 2;
        }
        const k = Math.max(this.transforms[this.view]?.k ?? 1, this.view === "constellation" ? 2 : 1.1);
        const w = this.stage.node().clientWidth, h = this.stage.node().clientHeight;
        this.svg.transition().duration(450)
            .call(this.zoomer.transform, zoomIdentity.translate(w / 2 - cx * k, h / 2 - cy * k).scale(k));
    }

    private fit(animate: boolean) {
        const node = this.layer.node();
        if (!node) return;
        const box = node.getBBox();
        const w = this.stage.node().clientWidth, h = this.stage.node().clientHeight;
        if (!box.width || !w || !h) return;
        let k = Math.min(2, 0.92 * Math.min(w / box.width, h / box.height));
        let t = zoomIdentity.translate(w / 2 - (box.x + box.width / 2) * k, h / 2 - (box.y + box.height / 2) * k).scale(k);
        if (this.view === "orgChart") {
            // columns already wrap to the width: show them at full size from the top, and drag to see the rest
            k = Math.min(1, Math.max(k, Math.min(1, (w - 16) / box.width)));
            const tx = w / 2 - (box.x + box.width / 2) * k;
            const ty = box.height * k <= h ? h / 2 - (box.y + box.height / 2) * k : 12 - box.y * k;
            t = zoomIdentity.translate(tx, ty).scale(k);
        }
        if (animate) this.svg.transition().duration(400).call(this.zoomer.transform, t);
        else this.svg.call(this.zoomer.transform, t);
    }

    private setupLasso() {
        let points: [number, number][] = [];
        let drawing = false;
        const draw = line().curve(curveBasisClosed);
        this.svg.on("pointerdown.lasso", (event: PointerEvent) => {
            if (!(this.lassoOn || event.shiftKey) || this.view !== "constellation" || event.button !== 0) return;
            drawing = true;
            points = [pointer(event, this.svg.node())];
            (event.target as Element).setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        this.svg.on("pointermove.lasso", (event: PointerEvent) => {
            if (!drawing) return;
            points.push(pointer(event, this.svg.node()));
            this.lassoPath.attr("d", draw(points));
        });
        this.svg.on("pointerup.lasso", (event: PointerEvent) => {
            if (!drawing) return;
            drawing = false;
            this.lassoPath.attr("d", null);
            if (points.length < 4) return;
            const t = this.transforms.constellation ?? zoomIdentity;
            const poly = points.map(([x, y]) => t.invert([x, y]) as [number, number]);
            const inside = this.data.people.filter(p => polygonContains(poly, [p.x, p.y]));
            this.justLassoed = true;
            this.setSelection(inside, event.ctrlKey || event.metaKey || event.shiftKey);
            this.zoomToPeople(inside, t);
            event.stopPropagation();
        });
    }

    // after a lasso, move in a little on the people picked; Fit goes back to everyone
    private zoomToPeople(people: Person[], from: ZoomTransform) {
        if (!people.length) return;
        const x0 = Math.min(...people.map(p => p.x - p.r)), x1 = Math.max(...people.map(p => p.x + p.r));
        const y0 = Math.min(...people.map(p => p.y - p.r)), y1 = Math.max(...people.map(p => p.y + p.r));
        const w = this.stage.node().clientWidth, h = this.stage.node().clientHeight;
        if (!w || !h) return;
        const fitK = 0.7 * Math.min(w / Math.max(x1 - x0, 1), h / Math.max(y1 - y0, 1));
        // a gentle step: at most 1.8 times closer, never further away, never past 3x
        const k = Math.max(from.k, Math.min(fitK, from.k * 1.8, 3));
        if (k <= from.k * 1.05) return;
        const t = zoomIdentity.translate(w / 2 - ((x0 + x1) / 2) * k, h / 2 - ((y0 + y1) / 2) * k).scale(k);
        this.svg.transition().duration(500).call(this.zoomer.transform, t);
    }
}

function tenure(d: Date): string {
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth();
    if (now.getDate() < d.getDate()) months--;
    months = Math.max(0, months);
    const y = Math.floor(months / 12), m = months % 12;
    const part = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    if (!y) return m ? part(m, "month") : "Less than a month";
    return m ? `${part(y, "year")} ${part(m, "month")}` : part(y, "year");
}

function trim(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

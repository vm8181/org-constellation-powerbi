"""
Writes the Power BI project (PBIP) for the Workforce Map report.

    python tools/build_pbip.py [path/to/visual.pbiviz]

Creates powerbi/OrgConstellation.* from data/people.csv and the packaged custom visual
(default: the newest .pbiviz in visual/dist). Run it again after changing the data or the visual.
The data is embedded in the model as a Power Query table, so the report opens with no file paths to set.
"""
import csv
import hashlib
import json
import shutil
import sys
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "powerbi"
NAME = "OrgConstellation"
SM = OUT / f"{NAME}.SemanticModel"
RP = OUT / f"{NAME}.Report"
SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition"


def tag(*parts) -> str:
    """Fixed id from a name, so rebuilding gives the same ids (clean git diffs)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "orgconstellation/" + "/".join(parts)))


def hexid(*parts) -> str:
    return hashlib.sha1("/".join(parts).encode()).hexdigest()[:20]


def write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def write_json(path: Path, obj):
    write(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")


def lit(v):
    return {"expr": {"Literal": {"Value": v}}}


def color(c):
    return {"solid": {"color": lit(f"'{c}'")}}


# ---------------------------------------------------------------------------- semantic model

COLUMNS = [  # name, TMDL type, M type, summarize, description
    ("PersonID", "string", "nullable text", "none", "Unique id of a person or open role."),
    ("ManagerID", "string", "nullable text", "none", "Person ID of the manager; blank for the top of the org."),
    ("Name", "string", "nullable text", "none", "Person's name, or 'Open role - <title>' for a vacancy."),
    ("Title", "string", "nullable text", "none", "Job title."),
    ("Team", "string", "nullable text", "none", "Department."),
    ("Unit", "string", "nullable text", "none", "The team a person works in, inside their department (for example Platform, North sales)."),
    ("Location", "string", "nullable text", "none", "Office, or Remote."),
    ("Level", "string", "nullable text", "none", "Executive, Head of team, Manager, Senior or Individual contributor."),
    ("Status", "string", "nullable text", "none", "Active, On leave or Open role."),
    ("AnnualCost", "int64", "Int64.Type", "sum", "Yearly cost of the person in rupees; 0 for an open role."),
    ("BudgetedCost", "int64", "Int64.Type", "sum", "Yearly budget for the position in rupees."),
    ("StartDate", "dateTime", "nullable date", "none", "Start date; blank for an open role."),
]

MEASURES = [  # name, DAX, format, folder, description
    ("Headcount", 'CALCULATE ( COUNTROWS ( People ), People[Status] <> "Open role" ) + 0', "#,0", "People",
     "People in post (open roles are not counted)."),
    ("Open Roles", 'CALCULATE ( COUNTROWS ( People ), People[Status] = "Open role" ) + 0', "#,0", "People",
     "Vacancies: positions with a budget and nobody in them yet."),
    ("On Leave", 'CALCULATE ( COUNTROWS ( People ), People[Status] = "On leave" ) + 0', "#,0", "People",
     "People currently on leave."),
    ("Avg Span of Control",
     "DIVIDE ( CALCULATE ( COUNTROWS ( People ), NOT ISBLANK ( People[ManagerID] ) ), DISTINCTCOUNTNOBLANK ( People[ManagerID] ) )",
     "0.0", "People", "Average number of direct reports per manager, for the people in view."),
    ("Staff Cost", "SUM ( People[AnnualCost] )", "₹#,0", "Cost", "Yearly cost of the people in view, in rupees."),
    ("Staff Cost Cr", "DIVIDE ( [Staff Cost], 10000000 )", "#,0.00", "Cost",
     "Staff Cost in crores of rupees (1 crore = 10 million)."),
    ("Budgeted Cost", "SUM ( People[BudgetedCost] )", "₹#,0", "Cost", "Yearly budget for the positions in view."),
    ("Unfilled Budget Cr", "DIVIDE ( [Budgeted Cost] - [Staff Cost], 10000000 )", "#,0.00", "Cost",
     "Budget not being spent because roles are open, in crores."),
    ("Selection Summary",
     'VAR picked = ISFILTERED ( People[PersonID] ) || ISFILTERED ( People[Team] ) || ISFILTERED ( People[Location] )\n'
     'VAR who = IF ( picked, "Selected: ", "Whole organisation: " )\n'
     'RETURN who & FORMAT ( [Headcount], "#,0" ) & " people  ·  ₹" & FORMAT ( [Staff Cost Cr], "#,0.0" ) & " Cr a year  ·  "\n'
     '    & FORMAT ( [Open Roles], "#,0" ) & IF ( [Open Roles] = 1, " open role", " open roles" )',
     None, "Text", "One line describing what is in view; changes when you lasso or click people."),
]


def m_value(v: str, mtype: str) -> str:
    if v == "":
        return "null"
    if mtype == "Int64.Type":
        return str(int(v))
    if mtype == "nullable date":
        y, m, d = v.split("-")
        return f"#date({int(y)}, {int(m)}, {int(d)})"
    return '"' + v.replace('"', '""') + '"'


def people_tmdl(rows) -> str:
    type_cols = ", ".join(f"{c[0]} = {c[2]}" for c in COLUMNS)
    body = ",\n".join("\t\t\t\t\t    {" + ", ".join(m_value(r[c[0]], c[2]) for c in COLUMNS) + "}" for r in rows)
    lines = ["/// One row per person or open role. ManagerID links each row to its manager, so the table is also the org tree.",
             "/// Fictional sample data made by tools/make_sample_data.py.",
             "table People", f"\tlineageTag: {tag('People')}", ""]
    for name, dtype, _, summ, desc in COLUMNS:
        lines += [f"\t/// {desc}", f"\tcolumn {name}", f"\t\tdataType: {dtype}"]
        if dtype == "dateTime":
            lines.append("\t\tformatString: dd mmm yyyy")
        if dtype == "int64":
            lines.append("\t\tformatString: ₹#,0")
        lines += [f"\t\tlineageTag: {tag('People', name)}", f"\t\tsummarizeBy: {summ}", f"\t\tsourceColumn: {name}", "",
                  "\t\tannotation SummarizationSetBy = Automatic", ""]
    lines += ["\tpartition People = m", "\t\tmode: import", "\t\tsource =", "\t\t\t\tlet",
              f"\t\t\t\t    Source = #table(type table [{type_cols}], {{",
              body,
              "\t\t\t\t    })", "\t\t\t\tin", "\t\t\t\t    Source", "", "\tannotation PBI_ResultType = Table", ""]
    return "\n".join(lines)


def measures_tmdl() -> str:
    lines = ["/// All measures, in display folders.", "table _Measures", f"\tlineageTag: {tag('_Measures')}", ""]
    for name, dax, fmt, folder, desc in MEASURES:
        lines.append(f"\t/// {desc}")
        if "\n" in dax:
            lines.append(f"\tmeasure '{name}' =")
            lines += [f"\t\t\t{x}" for x in dax.split("\n")]
        else:
            lines.append(f"\tmeasure '{name}' = {dax}")
        if fmt:
            lines.append(f"\t\tformatString: {fmt}")
        lines += [f"\t\tdisplayFolder: {folder}", f"\t\tlineageTag: {tag('_Measures', name)}", ""]
    lines += ["\tcolumn Dummy", "\t\tdataType: int64", "\t\tisHidden", "\t\tformatString: 0",
              f"\t\tlineageTag: {tag('_Measures', 'Dummy')}", "\t\tsummarizeBy: none", "\t\tsourceColumn: [Dummy]", "",
              "\t\tannotation SummarizationSetBy = Automatic", "",
              "\tpartition _Measures = calculated", "\t\tmode: import", '\t\tsource = ROW("Dummy", 0)', ""]
    return "\n".join(lines)


def build_model(rows):
    write(SM / "definition.pbism", json.dumps({"version": "4.2", "settings": {}}, indent=2) + "\n")
    write(SM / "definition" / "database.tmdl", "database\n\tcompatibilityLevel: 1606\n\n")
    write(SM / "definition" / "model.tmdl", "\n".join([
        "model Model", "\tculture: en-US", "\tdefaultPowerBIDataSourceVersion: powerBI_V3", "\tdiscourageImplicitMeasures",
        "\tsourceQueryCulture: en-US", "\tdataAccessOptions", "\t\tlegacyRedirects", "\t\treturnErrorValuesAsNull", "",
        "annotation __PBI_TimeIntelligenceEnabled = 0", "",
        'annotation PBI_QueryOrder = ["People"]', "",
        "ref table _Measures", "ref table People", ""]))
    write(SM / "definition" / "tables" / "People.tmdl", people_tmdl(rows))
    write(SM / "definition" / "tables" / "_Measures.tmdl", measures_tmdl())


# ---------------------------------------------------------------------------- report

def field(entity, prop, measure=False):
    kind = "Measure" if measure else "Column"
    return {kind: {"Expression": {"SourceRef": {"Entity": entity}}, "Property": prop}}


def proj(entity, prop, measure=False, display=None):
    p = {"field": field(entity, prop, measure), "queryRef": f"{entity}.{prop}", "nativeQueryRef": prop}
    if display:
        p["displayName"] = display
    return p


def container(title=None, background="#FFFFFF", border=True, subtitle=None, pad_top=4):
    o = {"background": [{"properties": {"show": lit("true"), "color": color(background), "transparency": lit("0D")}}],
         "border": [{"properties": {"show": lit("true" if border else "false"), "color": color("#E3E6EA"),
                                    "radius": lit("10D")}}],
         "padding": [{"properties": {"top": lit(f"{pad_top}D"), "bottom": lit("4D"), "left": lit("8D"), "right": lit("8D")}}],
         "dropShadow": [{"properties": {"show": lit("false")}}],
         # one subtitle style for the whole page (no automatic "X by Y" subtitle)
         "subTitle": [{"properties": {"show": lit("true"), "text": lit(f"'{subtitle}'"), "fontSize": lit("9D"),
                                      "fontColor": color("#6B7280"), "italic": lit("false"),
                                      "fontFamily": lit("'Segoe UI'"), "titleWrap": lit("true")}}] if subtitle else
                     [{"properties": {"show": lit("false")}}]}
    if title:
        o["title"] = [{"properties": {"show": lit("true"), "text": lit(f"'{title}'"), "fontSize": lit("12D"),
                                      "fontColor": color("#1F2937"), "bold": lit("true"),
                                      "fontFamily": lit("'Segoe UI Semibold'")}}]
    else:
        o["title"] = [{"properties": {"show": lit("false")}}]
    return o


def visual(page, key, vtype, x, y, w, h, z, query=None, objects=None, cobjects=None):
    vid = hexid(page, key)
    v = {"visualType": vtype}
    if query:
        v["query"] = query
    if objects:
        v["objects"] = objects
    if cobjects:
        v["visualContainerObjects"] = cobjects
    return vid, {"$schema": f"{SCHEMA}/visualContainer/2.14.0/schema.json", "name": vid,
                 "position": {"x": x, "y": y, "z": z, "width": w, "height": h, "tabOrder": z}, "visual": v}


def text_run(value, size, color_, bold=False):
    style = {"fontFamily": "'Segoe UI Semibold', wf_segoe-ui_semibold, helvetica, arial, sans-serif" if bold
             else "'Segoe UI', wf_segoe-ui_normal, helvetica, arial, sans-serif", "fontSize": f"{size}pt", "color": color_}
    if bold:
        style["fontWeight"] = "bold"
    return {"textRuns": [{"value": value, "textStyle": style}], "horizontalTextAlignment": "left"}


def card(page, key, measure, label, x, w, z):
    q = {"queryState": {"Values": {"projections": [proj("_Measures", measure, True, label)]}}}
    objs = {"labels": [{"properties": {"fontSize": lit("20D"), "color": color("#111827"), "labelDisplayUnits": lit("1D"),
                                       "fontFamily": lit("'Segoe UI Semibold'")}}],
            "categoryLabels": [{"properties": {"show": lit("true"), "fontSize": lit("10D"), "color": color("#4B5563")}}]}
    return visual(page, key, "card", x, 80, w, 66, z, q, objs, container(pad_top=0))  # no top padding: number sits centred


def build_report(guid: str):
    page = "workforce"
    pid = hexid("page", page)
    visuals = []

    visuals.append(visual(page, "title", "textbox", 16, 6, 760, 66, 1000, objects={"general": [{"properties": {"paragraphs": [
        text_run("Workforce Map", 16, "#111827", True),
        text_run("See who works where, who reports to whom, and what each team costs. Select people in the big visual "
                 "and every number on the page updates. All data is made up.", 10, "#4B5563")]}}]},
        cobjects={"background": [{"properties": {"show": lit("false")}}], "border": [{"properties": {"show": lit("false")}}]}))

    visuals.append(visual(page, "summary", "card", 792, 15, 472, 48, 1500,
                          {"queryState": {"Values": {"projections": [proj("_Measures", "Selection Summary", True)]}}},
                          {"labels": [{"properties": {"fontSize": lit("11D"), "color": color("#1F2937"),
                                                      "fontFamily": lit("'Segoe UI Semibold'")}}],
                           "categoryLabels": [{"properties": {"show": lit("false")}}],
                           "wordWrap": [{"properties": {"show": lit("true")}}]},
                          container(background="#EEF4FB", border=False)))

    cards = [("Headcount", "Headcount"), ("Staff Cost Cr", "Staff cost (₹ Cr a year)"), ("Open Roles", "Open roles"),
             ("On Leave", "On leave"), ("Avg Span of Control", "Avg direct reports per manager")]
    w = (1248 - 4 * 12) / 5
    for i, (m, label) in enumerate(cards):
        visuals.append(card(page, "card-" + m, m, label, 16 + i * (w + 12), w, 2000 + i * 100))

    people_roles = [("personId", "PersonID"), ("managerId", "ManagerID"), ("name", "Name"), ("title", "Title"),
                    ("team", "Team"), ("group", "Unit"), ("location", "Location"), ("status", "Status")]
    q = {"queryState": {r: {"projections": [proj("People", c)]} for r, c in people_roles}}
    q["queryState"]["size"] = {"projections": [proj("_Measures", "Staff Cost", True, "Staff cost")]}
    q["queryState"]["startDate"] = {"projections": [proj("People", "StartDate", display="Start date")]}
    q["queryState"]["budget"] = {"projections": [proj("_Measures", "Budgeted Cost", True, "Budget")]}
    visuals.append(visual(page, "org", guid, 16, 158, 924, 546, 3000, q,
                          {"view": [{"properties": {"defaultView": lit("'constellation'"), "clusterBy": lit("'reporting'")}}]},
                          container("People", subtitle="Each circle is a person. Lines show who reports to whom, and each colour is a "
                                    "department. Hold Shift and drag to select people, or switch to Org chart to see a "
                                    "manager and their teams.")))

    tq = {"queryState": {"Values": {"projections": [
        proj("People", "Team"), proj("_Measures", "Headcount", True, "People"),
        proj("_Measures", "Open Roles", True, "Open"), proj("_Measures", "Staff Cost Cr", True, "Cost (₹ Cr)")]}},
        "sortDefinition": {"sort": [{"field": field("_Measures", "Headcount", True), "direction": "Descending"}]}}
    visuals.append(visual(page, "teams", "tableEx", 952, 158, 312, 298, 4000, tq,
                          {"columnHeaders": [{"properties": {"fontSize": lit("9D"), "fontColor": color("#374151")}}],
                           "values": [{"properties": {"fontSize": lit("9D")}}],
                           "grid": [{"properties": {"rowPadding": lit("2D")}}],
                           "total": [{"properties": {"fontSize": lit("9D")}}]},
                          container("By team", subtitle="People, open roles and yearly cost for each department. "
                                    "Click a team to focus the page on it.")))

    bq = {"queryState": {"Category": {"projections": [{**proj("People", "Location"), "active": True}]},
                         "Y": {"projections": [proj("_Measures", "Headcount", True, "People")]}},
          "sortDefinition": {"sort": [{"field": field("_Measures", "Headcount", True), "direction": "Descending"}]}}
    visuals.append(visual(page, "locations", "clusteredBarChart", 952, 468, 312, 236, 5000, bq,
                          {"dataPoint": [{"properties": {"fill": color("#335C67")}}],
                           "labels": [{"properties": {"show": lit("true"), "fontSize": lit("10D")}}],
                           "valueAxis": [{"properties": {"show": lit("false")}}],
                           "categoryAxis": [{"properties": {"fontSize": lit("10D"), "showAxisTitle": lit("false"),
                                                            # all 7 offices fit without a scroll bar
                                                            "preferredCategoryWidth": lit("16D"),
                                                            "innerPadding": lit("30L")}}]},
                          container("People by location", subtitle="People in each office. Click a bar to filter.")))

    rd = RP / "definition"
    write(RP / "definition.pbir", json.dumps({"version": "4.0", "datasetReference": {"byPath": {"path": f"../{NAME}.SemanticModel"}}}, indent=2) + "\n")
    write_json(rd / "version.json", {"$schema": f"{SCHEMA}/versionMetadata/1.0.0/schema.json", "version": "2.0.0"})
    write_json(rd / "report.json", {
        "$schema": f"{SCHEMA}/report/3.3.0/schema.json",
        "themeCollection": {"baseTheme": {"name": "Fluent2-CY26SU10", "reportVersionAtImport": {"visual": "2.14.0", "report": "3.4.0", "page": "2.3.1"}, "type": "SharedResources"}},
        "resourcePackages": [
            {"name": "SharedResources", "type": "SharedResources",
             "items": [{"name": "Fluent2-CY26SU10", "path": "BaseThemes/Fluent2-CY26SU10.json", "type": "BaseTheme"}]},
            {"name": guid, "type": "CustomVisual",
             "items": [{"name": f"{guid}.pbiviz.json", "path": f"{guid}.pbiviz.json", "type": "CustomVisualMetadata"}]}],
        "settings": {"useStylableVisualContainerHeader": True, "exportDataMode": "AllowSummarized",
                     "defaultDrillFilterOtherVisuals": True, "allowChangeFilterTypes": True, "useEnhancedTooltips": True,
                     "useDefaultAggregateDisplayName": True}})
    write_json(rd / "pages" / "pages.json", {"$schema": f"{SCHEMA}/pagesMetadata/1.1.0/schema.json", "pageOrder": [pid], "activePageName": pid})
    write_json(rd / "pages" / pid / "page.json", {
        "$schema": f"{SCHEMA}/page/2.1.0/schema.json", "name": pid, "displayName": "Workforce Map",
        "displayOption": "FitToPage", "height": 720, "width": 1280,
        "objects": {"background": [{"properties": {"color": color("#F5F6F8"), "transparency": lit("0D")}}],
                    "outspace": [{"properties": {"color": color("#F5F6F8"), "transparency": lit("0D")}}]}})
    for vid, v in visuals:
        write_json(rd / "pages" / pid / "visuals" / vid / "visual.json", v)


def embed_visual(pbiviz: Path) -> str:
    """Puts the packaged visual inside the report, the way Power BI Desktop saves an imported visual."""
    with zipfile.ZipFile(pbiviz) as z:
        pkg = json.loads(z.read("package.json"))
        guid = pkg["visual"]["guid"]
        dest = RP / "CustomVisuals" / guid
        if dest.exists():
            shutil.rmtree(dest)
        (dest / "resources").mkdir(parents=True)
        (dest / "package.json").write_bytes(z.read("package.json"))
        res = next(n for n in z.namelist() if n.startswith("resources/") and n.endswith(".pbiviz.json"))
        (dest / "resources" / f"{guid}.pbiviz.json").write_bytes(z.read(res))
    return guid


def main():
    pbiviz = Path(sys.argv[1]) if len(sys.argv) > 1 else max((ROOT / "visual" / "dist").glob("*.pbiviz"), key=lambda p: p.stat().st_mtime)
    rows = list(csv.DictReader((ROOT / "data" / "people.csv").open(encoding="utf-8")))
    for d in (SM / "definition", RP / "definition"):
        if d.exists():
            shutil.rmtree(d)
    build_model(rows)
    guid = embed_visual(pbiviz)
    build_report(guid)
    write_json(OUT / f"{NAME}.pbip", {"version": "1.0", "artifacts": [{"report": {"path": f"{NAME}.Report"}}],
                                      "settings": {"enableAutoRecovery": True}})
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(rows)} rows, visual {guid}")


if __name__ == "__main__":
    main()

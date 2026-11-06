# Org Constellation: the guide in plain words

Author: Vikash Mishra

This guide explains what the project is, how each piece works, and why it was built this way, without assuming you have built a Power BI custom visual before.

## 1. The problem

A leader looking at their organisation asks simple questions. How many people do we have, and where? Who reports to whom? What does this group cost? Where are the open roles?

Power BI's own visuals answer these one at a time: a table for the list, a bar chart for locations, a decomposition tree for one branch. None of them shows the organisation as a whole, and none lets you point at a group of people and ask "what about these?".

## 2. The idea

Show the organisation two ways, in one visual:

- **Constellation.** Each person is a small avatar. By default they follow the reporting line: the top person in the middle, a line to each director, and a line from each director to their teams. Each team is a named cluster with its lead in the centre. Colour is the department. You can also regroup everyone by office or by department.
- **Org chart.** One manager at a time: their card, a card for each person reporting to them, and under each team lead a box of person cards. "Open ›" goes down a level, and the trail at the top goes back up. If you selected people in the constellation first, the org chart opens straight on them and shows only them, with their managers for context; "Show everyone" brings the rest back.

Then make it **interactive the Power BI way**: whatever you select in the visual filters the rest of the page.

## 3. The words used

| Term | Meaning | Everyday comparison |
| --- | --- | --- |
| **Custom visual** | A chart type you write yourself, in TypeScript, that Power BI loads like any built-in visual | Writing your own app for a phone that already has apps |
| **`.pbiviz`** | The packaged visual: one file you import into a report | An app installer |
| **Data roles** | The field wells the visual asks for (Person ID, Manager ID, Name...) | The labelled slots on a form |
| **Capabilities** | The file (`capabilities.json`) that tells Power BI the data roles, format options and features | The form's design |
| **Selection ID** | A tag Power BI gives each row, so the visual can say "filter to these rows" | A seat number |
| **Cross-filter** | Selecting in one visual filters the others | Pointing at a seat and everyone looks there |
| **Highlight** | Another visual's selection fades rows here instead of removing them | Dimming the lights instead of removing chairs |
| **Force simulation** | A layout method where dots push each other apart and are pulled towards a centre until they settle | Marbles rolling into bowls |
| **PBIP / PBIR / TMDL** | Power BI saved as text files: the project, the report and the model | A document saved as plain text, so Git can track changes |

## 4. How the data flows

1. **Power BI sends rows.** One row per person, with the fields you dragged into the wells. Power BI also gives each row a selection ID.
2. **The visual builds the tree** (`model.ts`). It links each person to their manager. If the manager isn't in the data, or someone accidentally reports to themselves through a chain, that person becomes top-level instead of breaking the picture. It also counts everyone under each manager.
3. **The visual places everyone** (`layout.ts`).
   - Reporting-line network: every manager is a cluster centre and their direct reports sit around them. First each cluster works out how much room it and everything under it needs; then each manager's clusters are placed on a ring around them, fanned out away from their own manager, so lines never cross. A last gentle step removes any small overlaps.
   - By location or team: clusters are placed so they don't overlap, then people are pulled towards their cluster's centre and pushed apart.
   - Org chart: the chosen manager's card, a card per direct report, and a grid of people under each team lead. Blocks wrap into rows to fit the visual's width.
4. **The visual draws and listens** (`visual.ts`). Clicks, the lasso, search, team chips, tooltips and the right-click menu are all handled here. A selection is turned back into selection IDs and handed to Power BI, which filters the rest of the page.

## 5. Why it was built this way

**Same data, same picture.** Force layouts usually start from random positions, so the picture changes every time you open the report. Here the start positions follow a fixed spiral, the random number generator has a fixed seed, and the simulation always runs the same number of steps. Open the report tomorrow and Bengaluru is in the same place.

**The reporting line, not the office.** The first version grouped people by office. It showed where people sit, but not who works with whom, and the lines only joined people inside one office. Following the reporting line makes every cluster a real team with a lead, and the lines show the structure at a glance.

**One manager at a time, not a giant tree.** With 20 managers and 150 people, a classic tree is several screens wide and unreadable when shrunk to fit. Showing one manager's part of the organisation, with teams as boxes of cards, keeps text full size; "Open ›" and the trail at the top move up and down.

**Filter by Person ID only.** The visual takes seven fields per person, but a selection should mean "these people", not "these exact combinations of seven values". Each selection ID is built from the Person ID column alone, so the filter the page receives is clean.

**Fade, don't remove.** When you click a bar in another visual, the people outside it fade instead of disappearing. Removing them would re-run the layout and every dot would jump, which is disorienting.

**A custom visual, not a Fabric App.** Fabric Apps are newer and very capable, but a custom visual works today on a Power BI Pro licence, inside an existing report and semantic model. The TypeScript could be moved into a Fabric App later.

## 6. The report page

The sample report, **Workforce Map**, has:

- a one-line summary that changes with your selection (lasso the Bengaluru office and it reads "Selected: 40 people · ₹8.8 Cr a year · 1 open role");
- five cards: headcount, staff cost, open roles, on leave, and average direct reports per manager;
- the visual itself;
- a team table and a people-by-location chart.

Draw a lasso around one office and every number on the page describes just those people.

The data is a fictional company of 175 positions across 8 teams and 7 locations, embedded in the model as a Power Query table. That's why the report opens with nothing to connect.

## 7. How it's checked

Every push to GitHub runs three things:

1. **The visual builds.** TypeScript type check, lint, and `pbiviz package`.
2. **The report is reproducible.** The sample data and the whole Power BI project are regenerated from code, and the run fails if anything differs from what's committed.
3. **The report files are valid.** Every report file is checked against Microsoft's published schemas, every formatting setting against the theme schema (and, for the custom visual, against its own capabilities), every field against the model, and the layout for overlaps.

During development the visual was also run in a browser test harness that imitates Power BI, to check both views, search, the lasso, cross-filter calls, highlights, tooltips and the empty state.

## 8. Using it with your own organisation

Put one row per person in a table with an employee ID and a manager ID, and drag the fields into the wells (see the README for the list). Everything else is optional. If you have more than 5,000 people, filter the page (for example to one division) first; that's the visual's data limit.

## 9. What could come next

- Colour pickers per team in the format pane
- A warning ring on managers with too many direct reports
- Small KPIs when hovering a cluster (cost, open roles, average tenure)
- The same visual as a Fabric App with write-back, for example to approve an open role

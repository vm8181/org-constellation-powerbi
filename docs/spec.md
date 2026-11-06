# Org Constellation: visual spec

A Power BI custom visual that shows an organisation two ways and lets you pick people by drawing around them.

## Why

The built-in visuals show an org as a table or a decomposition tree. Neither answers the questions a leader asks:
where are my people, how are teams spread across locations, who reports to whom, and what does a group of people cost.

## Data roles (fields the visual takes)

| Role | Kind | Required | Use |
| --- | --- | --- | --- |
| Person ID | column | yes | One row per person or open role |
| Manager ID | column | yes | Builds the reporting tree (blank = top of the org) |
| Name | column | yes | Label and search |
| Title | column | no | Tooltip, org chart card |
| Team | column | yes | Colour |
| Unit | column | no | Names clusters (reporting-line view) and team boxes (org chart) |
| Location | column | no | Cluster in constellation view |
| Status | column | no | `On leave` = hollow dot, `Open role` = dashed dot |
| Size | measure | no | Dot size (for example annual cost) |
| Tooltips | measures | no | Extra tooltip lines |

## Views

1. **Constellation.** Every person is a dot, coloured by team. Dots gather into clusters by Location (or by Team, switchable).
   Each cluster is labelled with its name and headcount. Faint lines join people to their manager inside a cluster.
2. **Org chart.** A tidy top-down tree from Manager ID. Cards show name, title and team colour; managers show their
   number of direct reports. Clicking a manager's chevron collapses or expands their branch.

Both views pan and zoom (mouse wheel, drag), and have a "fit" button.

## Interaction

- **Search** a name: matching people are highlighted and the view zooms to the first match.
- **Team chips** above the canvas: click to dim every other team (visual-only highlight, no filter).
- **Lasso** (constellation): draw around dots to select them. Selection cross-filters the rest of the page.
- **Click** a dot or card to select it; Ctrl+click adds to the selection; click empty space clears.
- **Reporting line** (org chart): selecting a manager also selects everyone under them.
- Right-click opens the Power BI context menu. Hover shows a tooltip.

## Format pane

- Default view (constellation / org chart), cluster by (location / team)
- Cluster labels, manager lines and toolbar on or off; dot size; text size
- Team colours follow the report theme (and switch to system colours in high contrast mode)

## Rules

- Works with 0 rows: shows a short "add fields" message.
- Up to 5,000 rows. The force layout runs a fixed number of ticks, so it is fast and
  the same data always draws the same picture.
- No external network calls. Respects high contrast mode for text and outlines.

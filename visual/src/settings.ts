"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import Card = formattingSettings.SimpleCard;
import Slice = formattingSettings.Slice;
import Model = formattingSettings.Model;

export const VIEW_OPTIONS = [
    { value: "constellation", displayName: "Constellation" },
    { value: "orgChart", displayName: "Org chart" }
];

export const CLUSTER_OPTIONS = [
    { value: "reporting", displayName: "Reporting line" },
    { value: "location", displayName: "Location" },
    { value: "team", displayName: "Team" }
];

/** "View" card: which view opens first and what the constellation groups by. */
class ViewCard extends Card {
    defaultView = new formattingSettings.ItemDropdown({
        name: "defaultView", displayName: "Default view", items: VIEW_OPTIONS, value: VIEW_OPTIONS[0]
    });
    clusterBy = new formattingSettings.ItemDropdown({
        name: "clusterBy", displayName: "Cluster by", items: CLUSTER_OPTIONS, value: CLUSTER_OPTIONS[0]
    });
    showClusterLabels = new formattingSettings.ToggleSwitch({
        name: "showClusterLabels", displayName: "Cluster labels", value: true
    });
    showLinks = new formattingSettings.ToggleSwitch({
        name: "showLinks", displayName: "Manager lines", value: true
    });
    showToolbar = new formattingSettings.ToggleSwitch({
        name: "showToolbar", displayName: "Toolbar", value: true
    });

    name = "view";
    displayName = "View";
    slices: Slice[] = [this.defaultView, this.clusterBy, this.showClusterLabels, this.showLinks, this.showToolbar];
}

/** "Dots and text" card. */
class DotsCard extends Card {
    dotSize = new formattingSettings.NumUpDown({
        name: "dotSize", displayName: "Dot size", value: 6,
        options: {
            minValue: { type: 0 /* ValidatorType.Min */, value: 2 },
            maxValue: { type: 1 /* ValidatorType.Max */, value: 20 }
        }
    });
    labelSize = new formattingSettings.NumUpDown({
        name: "labelSize", displayName: "Text size", value: 11
    });

    name = "dots";
    displayName = "Dots and text";
    slices: Slice[] = [this.dotSize, this.labelSize];
}

export class VisualSettings extends Model {
    view = new ViewCard();
    dots = new DotsCard();
    cards = [this.view, this.dots];
}

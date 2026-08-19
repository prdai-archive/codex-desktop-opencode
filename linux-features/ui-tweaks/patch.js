"use strict";

const sidebarProjectName = require("./patches/sidebar-project-name.js");
const modelPickerModelList = require("./patches/model-picker-model-list.js");
const reasoningEffortLabels = require("./patches/reasoning-effort-labels.js");
const dockIcon = require("./patches/dock-icon.js");
const suggestedPrompts = require("./patches/suggested-prompts.js");
const composerModelChip = require("./patches/composer-model-chip.js");
const providerLimitsWidget = require("./patches/provider-limits-widget.js");

function patchesFrom(...modules) {
  return modules.flatMap((moduleExports) =>
    Array.isArray(moduleExports?.descriptors) ? moduleExports.descriptors : [],
  );
}

module.exports = {
  descriptors: patchesFrom(
    sidebarProjectName,
    modelPickerModelList,
    reasoningEffortLabels,
    dockIcon,
    suggestedPrompts,
    composerModelChip,
    providerLimitsWidget,
  ),
};

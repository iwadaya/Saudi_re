// Shared re-export of the save-state banner.
//
// The component itself lives at screens/non_proportional/final_pricing/
// components/SaveStateIndicator.jsx for historical reasons. This file
// gives every screen (and WizardLayout) a stable import path under
// client/src/components/ without having to reach into another screen's
// folder.
export { default } from '../screens/non_proportional/final_pricing/components/SaveStateIndicator.jsx';

// client/src/components/ui — design-system primitives (Phase 3).
// Token-bound (tokens.css/themes.css only — no hard-coded colors) and
// a11y-wired. Import from here, not from per-file paths:
//
//   import { Button, Field, Modal, Table } from '../../components/ui';
//
// PctInput is the existing canonical % input, re-exported so screens
// can pull every form primitive from one barrel.
import './ui.css';

export { default as Button } from './Button.jsx';
export { Input, NumberInput } from './Input.jsx';
export { default as Field } from './Field.jsx';
export { default as Card } from './Card.jsx';
export { default as Modal } from './Modal.jsx';
export { default as Table } from './Table.jsx';
export { default as Badge } from './Badge.jsx';
export { default as Callout } from './Callout.jsx';
export { default as PctInput } from '../PctInput.jsx';

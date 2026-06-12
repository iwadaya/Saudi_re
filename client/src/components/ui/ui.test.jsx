// Render + a11y contract tests for the design-system primitives
// (docs/frontend-hardening.md Phase 3.1): real button semantics, focus
// trapping + restoration in Modal, label/control/error wiring in Field.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Button, Input, NumberInput, Field, Card, Modal, Table, Badge, Callout } from './index.js';

describe('Button', () => {
  it('is a real <button> with the variant/size classes', () => {
    render(<Button variant="primary" size="lg">Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.className).toContain('ui-btn--primary');
    expect(btn.className).toContain('ui-btn--lg');
    expect(btn).toHaveAttribute('type', 'button'); // never submits by accident
  });

  it('blocks interaction and announces busy while loading', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Field', () => {
  it('links the label to the control via htmlFor/id', () => {
    render(
      <Field label="Quota share EPI">
        <Input placeholder="0" />
      </Field>,
    );
    const input = screen.getByLabelText('Quota share EPI');
    expect(input).toBeInTheDocument();
  });

  it('wires hint and error through aria-describedby + aria-invalid', () => {
    render(
      <Field label="Retention" hint="As a % of EPI" error="Must be under 100%">
        <NumberInput />
      </Field>,
    );
    const input = screen.getByLabelText('Retention');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby') || '';
    const ids = describedBy.split(' ');
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0])).toHaveTextContent('As a % of EPI');
    expect(document.getElementById(ids[1])).toHaveTextContent('Must be under 100%');
    expect(screen.getByRole('alert')).toHaveTextContent('Must be under 100%');
  });
});

describe('Modal', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>open it</button>
        <Modal open={open} onClose={() => setOpen(false)} title="Layer details"
          footer={<Button onClick={() => setOpen(false)}>Done</Button>}>
          <Input aria-label="first control" />
        </Modal>
      </div>
    );
  }

  it('sets dialog semantics: role, aria-modal, labelled by the title', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('open it'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(document.getElementById(labelId)).toHaveTextContent('Layer details');
  });

  it('moves focus in on open and restores it on close', () => {
    render(<Harness />);
    const opener = screen.getByText('open it');
    opener.focus();
    fireEvent.click(opener);
    // first focusable inside the dialog (the header close button) gets focus
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close dialog' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('traps Tab: cycles from the last focusable back to the first', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('open it'));

    const closeBtn = screen.getByRole('button', { name: 'Close dialog' });
    const doneBtn = screen.getByRole('button', { name: 'Done' });
    doneBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeBtn);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(doneBtn);
  });

  it('closes on backdrop mousedown but not on panel clicks', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('open it'));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(document.querySelector('.ui-modal-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Table / Card / Badge / Callout', () => {
  it('Table renders a real table inside the scroll wrapper', () => {
    render(
      <Table aria-label="layers">
        <thead><tr><th>Layer</th></tr></thead>
        <tbody><tr><td>L1</td></tr></tbody>
      </Table>,
    );
    const table = screen.getByRole('table', { name: 'layers' });
    expect(table.parentElement.className).toContain('ui-table-wrap');
    expect(screen.getByRole('columnheader')).toHaveTextContent('Layer');
  });

  it('Card renders a section with its title', () => {
    render(<Card title="Treaty terms">body</Card>);
    expect(screen.getByText('Treaty terms').tagName).toBe('H3');
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('Badge applies tone classes', () => {
    render(<Badge tone="danger">NTU</Badge>);
    expect(screen.getByText('NTU').className).toContain('ui-badge--danger');
  });

  it('Callout warn/danger announce as alerts; note does not', () => {
    const { rerender } = render(<Callout variant="warn">Check the EPI.</Callout>);
    expect(screen.getByRole('alert')).toHaveTextContent('Check the EPI.');
    rerender(<Callout variant="note">FYI.</Callout>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent('FYI.');
  });
});

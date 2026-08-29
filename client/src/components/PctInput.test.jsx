// PctInput.test.jsx
//
// The canonical percentage input. Covers the `displayMaxDp` cap used by the
// quote tables: the idle display rounds to a max number of decimals, but
// focusing reveals the full-precision value and onChange emits it untouched —
// so only the rendered string is capped, never the stored value.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PctInput from './PctInput.jsx';

describe('PctInput', () => {
  it('appends % and emits the bare value on change (default, uncapped)', () => {
    const onChange = vi.fn();
    render(<PctInput value="12.3456" onChange={onChange} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('12.3456%');   // no cap by default
    fireEvent.change(input, { target: { value: '7.5%' } });
    expect(onChange).toHaveBeenCalledWith('7.5');
  });

  it('displayMaxDp caps the idle display but keeps full precision on entry', () => {
    const onChange = vi.fn();
    render(<PctInput value="12.3456" onChange={onChange} displayMaxDp={2} />);
    const input = screen.getByRole('textbox');
    // Idle: capped to 2 dp.
    expect(input).toHaveValue('12.35%');
    // Focus reveals the full-precision underlying value for editing.
    fireEvent.focus(input);
    expect(input).toHaveValue('12.3456');
    // Typing emits the raw entry untouched (no rounding of the stored value).
    fireEvent.change(input, { target: { value: '12.987654' } });
    expect(onChange).toHaveBeenCalledWith('12.987654');
    // Blur returns to the capped display of the (still full-precision) value.
    fireEvent.blur(input);
    expect(input).toHaveValue('12.35%');     // value prop unchanged in this test
  });

  it('trims trailing zeros in the capped display', () => {
    render(<PctInput value="85" onChange={() => {}} displayMaxDp={2} />);
    expect(screen.getByRole('textbox')).toHaveValue('85%');
  });

  // min/max live on a type="text" input, where the native attributes are
  // inert — the component clamps the committed value itself on blur.
  it('clamps an over-max value to max on blur', () => {
    const onChange = vi.fn();
    render(<PctInput value="8080" onChange={onChange} min={0} max={100} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('100');
  });

  it('clamps a below-min value to min on blur', () => {
    const onChange = vi.fn();
    render(<PctInput value="-5" onChange={onChange} min={0} max={100} />);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).toHaveBeenCalledWith('0');
  });

  it('leaves in-range values and empty entries untouched on blur', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PctInput value="27.5" onChange={onChange} min={0} max={100} />);
    fireEvent.blur(screen.getByRole('textbox'));
    rerender(<PctInput value="" onChange={onChange} min={0} max={100} />);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not clamp when no bounds are given', () => {
    const onChange = vi.fn();
    render(<PctInput value="130" onChange={onChange} />);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

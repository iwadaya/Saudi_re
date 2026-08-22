// PlacesAddressInput — the behaviours an underwriter depends on:
// the field never stops being a plain text box, picking enriches it, and
// editing away from a pick drops the coordinates rather than keeping stale ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PlacesAddressInput from './PlacesAddressInput.jsx';

const { apiMock } = vi.hoisted(() => ({ apiMock: {
  facPlacesStatus: vi.fn(),
  facPlacesSuggest: vi.fn(),
  facPlaceDetails: vi.fn(),
} }));
vi.mock('../api', () => ({ api: apiMock, default: apiMock }));

const SUGGESTIONS = [
  { placeId: 'P1', text: '12 King Fahd Rd, Riyadh', mainText: '12 King Fahd Rd', secondaryText: 'Riyadh, Saudi Arabia' },
  { placeId: 'P2', text: 'King Fahd Rd, Al Muruj', mainText: 'King Fahd Rd', secondaryText: 'Al Muruj, Riyadh' },
];

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
beforeEach(() => {
  apiMock.facPlacesStatus.mockResolvedValue({ configured: true });
  apiMock.facPlacesSuggest.mockResolvedValue({ suggestions: SUGGESTIONS });
  apiMock.facPlaceDetails.mockResolvedValue({
    placeId: 'P1',
    formattedAddress: '12 King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
    latitude: 24.6911,
    longitude: 46.6853,
  });
});

/** Render with a controlled value, returning a handle to the latest text. */
function setup(extra = {}) {
  const onChange = vi.fn();
  const onPlacePicked = vi.fn();
  const onPlaceCleared = vi.fn();
  const utils = render(
    <PlacesAddressInput
      value={extra.value ?? ''}
      onChange={onChange}
      onPlacePicked={onPlacePicked}
      onPlaceCleared={onPlaceCleared}
      placeholder="Physical address of premises"
      {...extra}
    />,
  );
  return { ...utils, onChange, onPlacePicked, onPlaceCleared };
}

/** Type into the box and let the 250ms debounce elapse. */
async function typeAndSettle(value) {
  const input = screen.getByPlaceholderText('Physical address of premises');
  fireEvent.change(input, { target: { value } });
  return input;
}

describe('when lookup is not configured', () => {
  beforeEach(() => { apiMock.facPlacesStatus.mockResolvedValue({ configured: false }); });

  it('stays a plain text input and never calls the lookup', async () => {
    setup();
    await waitFor(() => expect(apiMock.facPlacesStatus).toHaveBeenCalled());
    const input = await typeAndSettle('12 King Fahd Road');
    await new Promise(r => setTimeout(r, 400));
    expect(apiMock.facPlacesSuggest).not.toHaveBeenCalled();
    // No combobox semantics at all — it is just a box.
    expect(input).not.toHaveAttribute('role', 'combobox');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('treats a failing status probe as not configured', async () => {
    apiMock.facPlacesStatus.mockRejectedValue(new Error('boom'));
    setup();
    await typeAndSettle('12 King Fahd Road');
    await new Promise(r => setTimeout(r, 400));
    expect(apiMock.facPlacesSuggest).not.toHaveBeenCalled();
  });
});

describe('suggestions', () => {
  it('does not query below three characters', async () => {
    setup();
    await waitFor(() => expect(apiMock.facPlacesStatus).toHaveBeenCalled());
    await typeAndSettle('12');
    await new Promise(r => setTimeout(r, 400));
    expect(apiMock.facPlacesSuggest).not.toHaveBeenCalled();
  });

  it('debounces a burst of keystrokes into a single lookup', async () => {
    const { rerender } = setup();
    await waitFor(() => expect(apiMock.facPlacesStatus).toHaveBeenCalled());
    for (const v of ['12 K', '12 Ki', '12 Kin', '12 King']) {
      rerender(<PlacesAddressInput value={v} onChange={() => {}} placeholder="Physical address of premises" />);
    }
    await waitFor(() => expect(apiMock.facPlacesSuggest).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(apiMock.facPlacesSuggest.mock.calls[0][0]).toMatchObject({ input: '12 King' });
  });

  it('lists them with combobox semantics once they arrive', async () => {
    setup({ value: '12 King Fahd' });
    const input = screen.getByPlaceholderText('Physical address of premises');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument(), { timeout: 2000 });
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('12 King Fahd Rd')).toBeInTheDocument();
    expect(screen.getByText('Riyadh, Saudi Arabia')).toBeInTheDocument();
  });

  it('sends a session token so the lookup bills as one session', async () => {
    setup({ value: '12 King Fahd' });
    await waitFor(() => expect(apiMock.facPlacesSuggest).toHaveBeenCalled(), { timeout: 2000 });
    expect(apiMock.facPlacesSuggest.mock.calls[0][0].sessionToken).toBeTruthy();
  });

  it('keeps the field usable when the lookup errors', async () => {
    apiMock.facPlacesSuggest.mockRejectedValue(new Error('upstream down'));
    setup({ value: '12 King Fahd' });
    await waitFor(() => expect(apiMock.facPlacesSuggest).toHaveBeenCalled(), { timeout: 2000 });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText('Physical address of premises')).toBeInTheDocument();
  });
});

describe('picking a suggestion', () => {
  it('resolves it and hands back the formatted address plus coordinates', async () => {
    const { onPlacePicked } = setup({ value: '12 King Fahd' });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument(), { timeout: 2000 });

    fireEvent.mouseDown(screen.getAllByRole('option')[0]);

    await waitFor(() => expect(onPlacePicked).toHaveBeenCalledWith({
      address: '12 King Fahd Rd, Al Olaya, Riyadh 12214, Saudi Arabia',
      latitude: 24.6911,
      longitude: 46.6853,
      placeId: 'P1',
    }));
    expect(apiMock.facPlaceDetails).toHaveBeenCalledWith(expect.objectContaining({ placeId: 'P1' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('still fills the address when the details call fails, just without coordinates', async () => {
    apiMock.facPlaceDetails.mockRejectedValue(new Error('timeout'));
    const { onChange, onPlacePicked } = setup({ value: '12 King Fahd' });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument(), { timeout: 2000 });

    fireEvent.mouseDown(screen.getAllByRole('option')[0]);

    await waitFor(() => expect(apiMock.facPlaceDetails).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith('12 King Fahd Rd, Riyadh'); // the suggestion text
    expect(onPlacePicked).not.toHaveBeenCalled();                     // no coordinates claimed
  });

  it('is reachable by keyboard alone', async () => {
    const { onPlacePicked } = setup({ value: '12 King Fahd' });
    const input = screen.getByPlaceholderText('Physical address of premises');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument(), { timeout: 2000 });

    fireEvent.keyDown(input, { key: 'ArrowDown' });   // → first row
    fireEvent.keyDown(input, { key: 'ArrowDown' });   // → second row
    fireEvent.keyDown(input, { key: 'ArrowUp' });     // → back to first
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id);

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onPlacePicked).toHaveBeenCalled());
  });

  it('closes on Escape without picking', async () => {
    const { onPlacePicked } = setup({ value: '12 King Fahd' });
    const input = screen.getByPlaceholderText('Physical address of premises');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument(), { timeout: 2000 });

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onPlacePicked).not.toHaveBeenCalled();
  });
});

describe('coordinate hygiene', () => {
  it('confirms captured coordinates to the user', () => {
    setup({ value: 'somewhere', hasCoords: true });
    expect(screen.getByText(/location captured/i)).toBeInTheDocument();
  });

  it('drops them the moment the address is edited by hand', async () => {
    // Stale coordinates are worse than none: they would point at the building
    // the address USED to name.
    const { onPlaceCleared } = setup({ value: '12 King Fahd Rd', hasCoords: true });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Physical address of premises'), {
        target: { value: '12 King Fahd Rd, Unit 4' },
      });
    });
    expect(onPlaceCleared).toHaveBeenCalled();
  });

  it('does not fire the clear when there were no coordinates to begin with', async () => {
    const { onPlaceCleared } = setup({ value: 'abc', hasCoords: false });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Physical address of premises'), { target: { value: 'abcd' } });
    });
    expect(onPlaceCleared).not.toHaveBeenCalled();
  });
});

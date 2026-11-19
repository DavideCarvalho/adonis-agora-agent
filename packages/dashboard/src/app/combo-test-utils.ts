import { act, fireEvent, screen } from '@testing-library/react';

const settle = () => new Promise((r) => setTimeout(r, 20));

/**
 * Open a kit combo (`ComboSelect`), optionally type into it, and pick the option named `option`.
 * Base UI opens the popup on ArrowDown, not on an input event (jsdom/happy-dom).
 */
export async function pickComboOption(
  input: HTMLElement,
  option: string | RegExp,
  typed = '',
): Promise<void> {
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    if (typed !== '') fireEvent.change(input, { target: { value: typed } });
    await settle();
  });
  const item = await screen.findByRole('option', { name: option });
  await act(async () => {
    fireEvent.click(item);
    await settle();
  });
}

/** Open a kit combo and list its options' names. */
export async function comboOptionNames(input: HTMLElement): Promise<string[]> {
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await settle();
  });
  await screen.findAllByRole('option');
  return screen.getAllByRole('option').map((o) => o.textContent ?? '');
}

/** Close an open combo popup. */
export async function closeCombo(input: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Escape' });
    await settle();
  });
}

/** Open a kit `ScopeMenu` (its listbox button) and list its options' names; closes it again. */
export async function scopeOptionNames(button: HTMLElement): Promise<string[]> {
  await act(async () => {
    fireEvent.click(button);
    await settle();
  });
  const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
  await act(async () => {
    fireEvent.click(button);
    await settle();
  });
  return names;
}

/** Open a kit `ScopeMenu`, optionally search, and pick the option named `option` (on mousedown). */
export async function pickScopeOption(
  button: HTMLElement,
  option: string | RegExp,
  typed = '',
): Promise<void> {
  await act(async () => {
    fireEvent.click(button);
    await settle();
  });
  if (typed !== '') {
    const search = screen.getByRole('combobox');
    await act(async () => {
      fireEvent.change(search, { target: { value: typed } });
      await settle();
    });
  }
  const item = screen.getByRole('option', { name: option });
  await act(async () => {
    fireEvent.mouseDown(item);
    await settle();
  });
}

/** The header picker button whose noun is `noun` (`App`, `Organization`). */
export function scopeButton(noun: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: new RegExp(`^${noun}`) });
}

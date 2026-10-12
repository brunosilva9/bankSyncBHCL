import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, initTheme, saveTheme, storedTheme, systemTheme } from './theme';

const matchDark = (dark: boolean) => vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: dark }));

describe('tema', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    vi.unstubAllGlobals();
  });

  it('sigue el tema del sistema si no hay preferencia', () => {
    matchDark(true);
    expect(systemTheme()).toBe('dark');
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('respeta el tema guardado sobre el del sistema', () => {
    matchDark(true);
    localStorage.setItem('syncbanks-theme', 'light');
    expect(storedTheme()).toBe('light');
    expect(initTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('saveTheme guarda la elección y la aplica', () => {
    saveTheme('dark');
    expect(storedTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('ignora un valor guardado que no es un tema', () => {
    localStorage.setItem('syncbanks-theme', 'azul');
    expect(storedTheme()).toBeNull();
  });

  it('applyTheme fija el atributo en el documento', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

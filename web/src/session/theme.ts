/**
 * Resolves the "follow the system" theme choice inside the page. Native code sends
 * the user's preference; the media query is only consulted for `system`.
 */
const query = window.matchMedia('(prefers-color-scheme: dark)');

export function systemPrefersDark(): boolean {
  return query.matches;
}

export function CSS_LIGHT_DARK(): 'light' | 'dark' {
  return systemPrefersDark() ? 'dark' : 'light';
}

export function onSystemThemeChange(handler: (dark: boolean) => void): () => void {
  const listener = (event: MediaQueryListEvent): void => handler(event.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

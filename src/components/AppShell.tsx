import { Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';

export const THEME_STORAGE_KEY = 'coarse-grid.theme';

export type Theme = 'light' | 'dark';

/** Read the persisted theme; never throws even if localStorage is blocked. */
export function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' ? 'dark' : 'light';
  } catch {
    // Storage can be unavailable (private mode, blocked init script).
    return 'light';
  }
}

/** Persist the theme choice; never throws even if localStorage is blocked. */
export function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore persistence failures; the in-memory class toggle still works.
  }
}

export function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

interface AppShellProps {
  theme: Theme;
  onToggleTheme: () => void;
  children?: React.ReactNode;
}

export default function AppShell({ theme, onToggleTheme, children }: AppShellProps) {
  const dark = theme === 'dark';

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-[78rem] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Coarse Grid</h1>
            <p className="mt-1 max-w-[48rem] text-sm text-muted-foreground">
              Apply the raster filter on your GPU in linear light and export
              composited PNGs — fully local, nothing uploaded.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={onToggleTheme}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[78rem] flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-[78rem] px-4 py-4 text-sm text-muted-foreground sm:px-6">
          <p>Images are processed only in this browser&apos;s GPU. Nothing is uploaded or stored.</p>
        </div>
      </footer>
    </div>
  );
}

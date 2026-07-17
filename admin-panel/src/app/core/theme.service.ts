import { Injectable, signal } from '@angular/core';

type Theme = 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly stored = localStorage.getItem('hub-theme') as Theme | null;

  readonly theme = signal<Theme>(
    this.stored ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );

  constructor() {
    // Sempre grava o atributo (mesmo quando o valor vem do prefers-color-scheme, não de
    // localStorage) — o PrimeNG (ver app.config.ts, providePrimeNG darkModeSelector) só reage a
    // esse atributo, não à media query.
    document.documentElement.setAttribute('data-theme', this.theme());
  }

  toggle(): void {
    const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('hub-theme', next);
  }
}

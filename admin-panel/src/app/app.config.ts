import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeuix/themes/aura';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // darkModeSelector casado com o atributo que o ThemeService escreve em <html> — mesmo
    // padrão usado no gestao-carga, pra manter o tema do PrimeNG em sincronia com o resto da UI.
    providePrimeNG({
      theme: {
        preset: Aura,
        options: { darkModeSelector: '[data-theme="dark"]', cssLayer: false }
      }
    })
  ]
};

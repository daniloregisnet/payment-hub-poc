import { Component, inject, signal } from '@angular/core';
import { Drawer } from 'primeng/drawer';
import { Dialog } from 'primeng/dialog';
import { ScenarioCardComponent } from './scenario-card/scenario-card.component';
import { SCENARIOS, ScenarioDef } from './models/scenario.model';
import { HELP_SECTIONS } from './models/help-content';
import { ThemeService } from './core/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ScenarioCardComponent, Drawer, Dialog],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly theme = inject(ThemeService);

  protected readonly scenarios = SCENARIOS;
  protected readonly helpSections = HELP_SECTIONS;
  protected readonly kialiUrl = 'http://localhost:20001/kiali/console/namespaces/payment-hub/graph';

  protected readonly roteiroOpen = signal(false);
  protected readonly selectedScenario = signal<ScenarioDef | null>(null);
  protected readonly helpOpen = signal(false);

  openRoteiro(scenario: ScenarioDef): void {
    this.selectedScenario.set(scenario);
    this.roteiroOpen.set(true);
  }
}

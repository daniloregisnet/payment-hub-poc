import { Component } from '@angular/core';
import { ScenarioCardComponent } from './scenario-card/scenario-card.component';
import { SCENARIOS } from './models/scenario.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ScenarioCardComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly scenarios = SCENARIOS;
  protected readonly kialiUrl = 'http://localhost:20001/kiali/console/namespaces/payment-hub/graph';
}

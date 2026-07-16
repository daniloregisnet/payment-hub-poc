import { Component, Input, inject, signal } from '@angular/core';
import { ScenarioService, SseEvent } from '../services/scenario.service';
import { LogLevel, LogLine, ScenarioDef } from '../models/scenario.model';

@Component({
  selector: 'app-scenario-card',
  standalone: true,
  imports: [],
  template: `
    <div class="card" [class.running]="running()">
      <div class="card-header">
        <span class="icon">{{ scenario.icon }}</span>
        <div class="titles">
          <h3>{{ scenario.title }}</h3>
          <span class="duration">{{ scenario.estimatedDuration }}</span>
        </div>
        @if (lastResult() !== 'idle') {
          <span
            class="badge"
            [class.badge-success]="lastResult() === 'success'"
            [class.badge-error]="lastResult() === 'error'"
            [class.badge-cancelled]="lastResult() === 'cancelled'">
            {{ lastResult() === 'success' ? 'OK' : lastResult() === 'cancelled' ? 'Cancelado' : 'Erro' }}
          </span>
        }
      </div>

      <p class="description">{{ scenario.description }}</p>

      <div class="actions">
        <button type="button" class="btn-run" [disabled]="running()" (click)="run()">
          {{ running() ? 'Executando…' : 'Executar cenário' }}
        </button>
        @if (running()) {
          <button type="button" class="btn-cancel" (click)="cancel()">Cancelar</button>
        }
      </div>

      @if (logs().length > 0) {
        <div class="log">
          @for (line of logs(); track $index) {
            <div class="log-line" [class]="'log-' + line.level">
              <span class="log-time">{{ line.timestamp }}</span>
              <span class="log-msg">{{ line.message }}</span>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .card {
      border: 1px solid #dfe3e8;
      border-radius: 8px;
      padding: 18px;
      background: #fff;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: box-shadow 150ms ease;
    }
    .card.running {
      box-shadow: 0 0 0 2px #2f6f4f;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .icon { font-size: 26px; }
    .titles { flex: 1; display: flex; flex-direction: column; }
    .titles h3 { margin: 0; font-size: 15px; }
    .duration { font-size: 11px; color: #6b7280; }
    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 10px;
      background: #f5f7fa;
      color: #6b7280;
    }
    .badge-success { background: #e3f1e8; color: #234f38; }
    .badge-error { background: #fbe4e4; color: #8a3a3a; }
    .badge-cancelled { background: #f5f7fa; color: #6b7280; }
    .description { margin: 0; font-size: 13px; color: #4b5563; line-height: 1.5; }
    .actions { display: flex; gap: 8px; }
    .btn-run {
      flex: 1;
      padding: 9px 14px;
      border: none;
      border-radius: 6px;
      background: #2f6f4f;
      color: #fff;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-run:hover:not(:disabled) { background: #234f38; }
    .btn-run:disabled { background: #a8c3b6; cursor: wait; }
    .btn-cancel {
      padding: 9px 14px;
      border: 1px solid #dfe3e8;
      border-radius: 6px;
      background: #fff;
      color: #8a3a3a;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-cancel:hover { background: #fbe4e4; }
    .log {
      max-height: 220px;
      overflow-y: auto;
      background: #0f1620;
      border-radius: 6px;
      padding: 10px 12px;
      font-family: 'SFMono-Regular', Consolas, monospace;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .log-line { display: flex; gap: 8px; }
    .log-time { color: #6b7280; flex-shrink: 0; }
    .log-info .log-msg { color: #cbd5e1; }
    .log-success .log-msg { color: #7fdba6; }
    .log-warn .log-msg { color: #e6c260; }
    .log-error .log-msg { color: #f0a5a5; }
  `]
})
export class ScenarioCardComponent {
  @Input({ required: true }) scenario!: ScenarioDef;

  private readonly service = inject(ScenarioService);

  readonly running = signal(false);
  readonly logs = signal<LogLine[]>([]);
  readonly lastResult = signal<'idle' | 'success' | 'error' | 'cancelled'>('idle');

  private abortController: AbortController | null = null;

  async run(): Promise<void> {
    this.running.set(true);
    this.logs.set([]);
    this.lastResult.set('idle');
    this.addLog('info', `Iniciando ${this.scenario.title}…`);

    const controller = new AbortController();
    this.abortController = controller;

    try {
      if (this.scenario.streaming) {
        await this.service.runStreaming(this.scenario.path, (e) => this.handleStreamEvent(e), controller.signal);
      } else {
        const result = await this.service.run(this.scenario.path, controller.signal);
        this.handleSimpleResult(result);
      }
      this.lastResult.set('success');
    } catch (err) {
      if (controller.signal.aborted) {
        this.addLog('warn', 'Cancelado — o backend também para de processar assim que detecta a desconexão.');
        this.lastResult.set('cancelled');
      } else {
        this.addLog('error', `Falha ao executar: ${err}`);
        this.lastResult.set('error');
      }
    } finally {
      this.running.set(false);
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  private handleSimpleResult(result: any): void {
    if (this.scenario.id === 'happy-path') {
      this.addLog('success', `${result.success}/${result.requests} requisições com sucesso — latência média ${result.avgLatencyMs}ms`);
      return;
    }

    if (this.scenario.id === 'auth-denied') {
      const api = result.toPaymentApi;
      const db = result.toPaymentDb;
      this.addLog(api.allowed ? 'success' : 'error', `→ payment-api: ${api.statusCode} (${api.allowed ? 'permitido ✓' : 'bloqueado'})`);
      this.addLog(db.denied ? 'success' : 'error', `→ payment-db: ${db.statusCode} (${db.denied ? 'negado ✓ — AuthorizationPolicy funcionando' : 'permitido inesperadamente!'})`);
      return;
    }

    this.addLog('info', JSON.stringify(result));
  }

  private handleStreamEvent(e: SseEvent): void {
    const d = e.data as any;

    if (e.event === 'start') {
      this.addLog('info', `${d.requests ? d.requests + ' requisições' : 'Iniciado'}`);
      return;
    }

    if (e.event === 'phase') {
      this.addLog('info', `— ${d.label} —`);
      return;
    }

    if (e.event === 'progress') {
      if (typeof d.waitingSeconds === 'number') {
        this.addLog('warn', `Aguardando recuperação… ${d.waitingSeconds}s restantes`);
        return;
      }
      if (typeof d.completed === 'number') {
        this.addLog('info', `${d.completed}/${d.total} concluídas — ${d.accepted} aceitas, ${d.rejected} rejeitadas (429)`);
        return;
      }
      if (typeof d.statusCode === 'number') {
        const level: LogLevel = d.statusCode >= 200 && d.statusCode < 300 ? 'success' : d.statusCode === 0 ? 'error' : 'warn';
        const label = d.request ? `Tentativa ${d.request}` : 'Requisição';
        this.addLog(level, `${label}: status ${d.statusCode} em ${d.durationMs}ms${d.note ? ' — ' + d.note : ''}`);
        return;
      }
      this.addLog('info', JSON.stringify(d));
      return;
    }

    if (e.event === 'done') {
      if (typeof d.accepted === 'number') {
        this.addLog('success', `Final: ${d.accepted} aceitas, ${d.rejected429} rejeitadas com 429, ${d.otherErrors} outros erros`);
      } else {
        this.addLog('success', 'Cenário concluído.');
      }
      return;
    }
  }

  private addLog(level: LogLevel, message: string): void {
    const timestamp = new Date().toLocaleTimeString('pt-BR');
    this.logs.update((l) => [...l, { level, message, timestamp }]);
  }
}

export interface ScenarioDef {
  id: string;
  title: string;
  icon: string;
  description: string;
  path: string;
  streaming: boolean;
  estimatedDuration: string;
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogLine {
  level: LogLevel;
  message: string;
  timestamp: string;
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'happy-path',
    title: '1. Happy Path',
    icon: '✅',
    description: '10 pagamentos bem-sucedidos em sequência — fluxo normal, sem falhas.',
    path: 'happy-path',
    streaming: false,
    estimatedDuration: '~1s'
  },
  {
    id: 'timeout-retry',
    title: '2. Timeout + Retry',
    icon: '⏱️',
    description: 'payment-db fica lento (15s) — o timeout do VirtualService (5s) deve cortar antes.',
    path: 'timeout-retry',
    streaming: true,
    estimatedDuration: '~15s'
  },
  {
    id: 'backpressure',
    title: '3. Backpressure',
    icon: '🌊',
    description: '100 requisições paralelas pro settlement-queue — a fila enche (max 50) e passa a rejeitar com 429.',
    path: 'backpressure',
    streaming: true,
    estimatedDuration: '~5s'
  },
  {
    id: 'circuit-breaker',
    title: '4. Circuit Breaker',
    icon: '🔌',
    description: 'payment-db falha 5x seguidas, o circuito abre, aguarda 30s e testa a recuperação automática.',
    path: 'circuit-breaker',
    streaming: true,
    estimatedDuration: '~40s'
  },
  {
    id: 'auth-denied',
    title: '5. Authorization Denied',
    icon: '🚫',
    description: 'settlement-queue tenta chamar payment-db diretamente — a AuthorizationPolicy deve bloquear (403).',
    path: 'auth-denied',
    streaming: false,
    estimatedDuration: '~1s'
  }
];

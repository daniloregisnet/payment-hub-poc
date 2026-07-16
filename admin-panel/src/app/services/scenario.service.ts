import { Injectable } from '@angular/core';

export interface SseEvent {
  event: string;
  data: unknown;
}

@Injectable({ providedIn: 'root' })
export class ScenarioService {
  private readonly base = '/api/scenarios';

  /** Cenários simples (happy-path, auth-denied) — uma resposta JSON só. */
  async run(path: string, signal?: AbortSignal): Promise<unknown> {
    const resp = await fetch(`${this.base}/${path}`, { method: 'POST', signal });
    return resp.json();
  }

  /**
   * Cenários em streaming (timeout-retry, backpressure, circuit-breaker) — o backend manda
   * Server-Sent Events. Não dá pra usar EventSource nativo porque ele só faz GET; aqui a gente
   * lê o corpo da resposta como stream e faz o parse manual do formato "event: X\ndata: Y\n\n".
   *
   * O signal cancela o fetch (botão "Cancelar" no card) — como o backend lê r.Context(), a
   * conexão fechada também interrompe o processamento no servidor, não só a exibição aqui.
   */
  async runStreaming(path: string, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<void> {
    const resp = await fetch(`${this.base}/${path}`, { method: 'POST', signal });
    if (!resp.body) throw new Error('Streaming não suportado pelo navegador');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';

      for (const raw of messages) {
        const event = parseSseMessage(raw);
        if (event) onEvent(event);
      }
    }
  }
}

function parseSseMessage(raw: string): SseEvent | null {
  let eventName = 'message';
  let dataLine = '';

  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) dataLine = line.slice(5).trim();
  }

  if (!dataLine) return null;

  try {
    return { event: eventName, data: JSON.parse(dataLine) };
  } catch {
    return { event: eventName, data: dataLine };
  }
}

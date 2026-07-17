export interface Roteiro {
  descricao: string;
  aposClique: string;
  explicar: string;
  istioConfig: string;
}

export interface ScenarioDef {
  id: string;
  title: string;
  icon: string;
  description: string;
  path: string;
  streaming: boolean;
  estimatedDuration: string;
  roteiro: Roteiro;
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
    estimatedDuration: '~1s',
    roteiro: {
      descricao:
        'Fluxo normal de um pagamento, passando pela cadeia inteira (payment-api → payment-cache → payment-db) sem nenhuma falha ou degradação. É o "baseline" — o que a plateia precisa ver ANTES dos cenários de falha, pra ter uma referência do que é "tudo funcionando".',
      aposClique:
        'Por ~1 segundo, você verá 10 requisições ao payment-api (/process-payment), todas com sucesso (200) e latência de poucos milissegundos.',
      explicar:
        'Mostre o Kiali com o Traffic Animation ligado: as setas ficam verdes, sem erro, sem latência visível. Aproveite pra apontar a topologia real (api → cache → db) antes de começar a quebrar as coisas de propósito nos próximos cenários.',
      istioConfig:
        'Nenhuma configuração especial de resiliência entra em ação aqui — só o mTLS automático do ztunnel (PeerAuthentication STRICT) protegendo a comunicação, de forma completamente transparente pro app.'
    }
  },
  {
    id: 'timeout-retry',
    title: '2. Timeout + Retry',
    icon: '⏱️',
    description: 'payment-db fica lento (15s) — o timeout do VirtualService (5s) deve cortar antes.',
    path: 'timeout-retry',
    streaming: true,
    estimatedDuration: '~15-20s',
    roteiro: {
      descricao:
        'O payment-db simula lentidão extrema (15 segundos pra responder). A rota /check-fraud tem um timeout de 5 segundos configurado no VirtualService — o Istio desiste de esperar antes do backend sequer terminar de processar.',
      aposClique:
        'Por ~15-20 segundos: 3 tentativas de chamar /check-fraud (api → cache → db). A 1ª tentativa mostra o timeout genuíno (504 Gateway Timeout, ~5000ms — o Envoy desistiu exatamente no tempo configurado). As tentativas seguintes tendem a falhar bem mais rápido (503, poucos milissegundos).',
      explicar:
        'O ponto mais interessante deste cenário nem é o timeout em si — é perceber que a 2ª e 3ª tentativa falham RÁPIDO, não em 5s. Isso é o circuit breaker (Cenário 4) entrando em ação dentro deste mesmo teste: depois de uma falha, o Envoy já para de insistir em chamar um serviço que provou estar com problema. É a ponte perfeita pra introduzir o próximo cenário — não é bug, é o mesh já protegendo o sistema.',
      istioConfig:
        'VirtualService "payment-api", rota /check-fraud: campo `timeout: 5s`. Sem esse timeout explícito, a chamada ficaria presa esperando os 15s do backend — o cliente (e quem chamou ele) travaria junto.'
    }
  },
  {
    id: 'backpressure',
    title: '3. Backpressure',
    icon: '🌊',
    description: '100 requisições paralelas pro payment-queue — a fila enche (max 50) e passa a rejeitar com 429.',
    path: 'backpressure',
    streaming: true,
    estimatedDuration: '~5s',
    roteiro: {
      descricao:
        '100 requisições disparadas em paralelo pro payment-queue, que só comporta 50 itens simultâneos na fila interna.',
      aposClique:
        'Por ~5 segundos: as primeiras ~50 requisições retornam 202 (aceitas na fila); as outras ~50 retornam 429 Too Many Requests (fila cheia).',
      explicar:
        'Diferencie claramente do Circuit Breaker: aqui quem decide recusar é o PRÓPRIO aplicativo (uma fila com tamanho máximo definido no código), não o mesh. É o padrão de backpressure — em vez de aceitar trabalho indefinidamente e estourar memória ou degradar tudo, o serviço se protege recusando o excesso educadamente, com uma mensagem clara, permitindo que quem chamou tente de novo mais tarde.',
      istioConfig:
        'DestinationRule "payment-queue-dr": `connectionPool.http.http1MaxPendingRequests: 100` — dimensionado pra caber a rajada inteira sem o MESH rejeitar antes da fila do app conseguir ser o gargalo real (se esse valor fosse baixo, o Envoy cortaria a rajada antes mesmo de chegar no app, mascarando a demonstração).'
    }
  },
  {
    id: 'circuit-breaker',
    title: '4. Circuit Breaker',
    icon: '🔌',
    description: 'payment-db falha 5x seguidas, o circuito abre, aguarda 30s e testa a recuperação automática.',
    path: 'circuit-breaker',
    streaming: true,
    estimatedDuration: '~40s',
    roteiro: {
      descricao:
        'O payment-db "quebra" de propósito (5 respostas de erro seguidas). O DestinationRule do Istio detecta e ejeta o destino do balanceamento de carga por um tempo, depois testa sozinho se ele já recuperou.',
      aposClique:
        'Por ~40 segundos, em 3 fases visíveis no painel: Fase 1 (~5s) — 5 chamadas com erro forçado, todas falhando. Fase 2 (30s) — nenhuma chamada é feita, é a janela de "circuito aberto" (contagem regressiva no painel). Fase 3 (~3s) — 3 chamadas normais, que devem voltar a funcionar, demonstrando recuperação automática.',
      explicar:
        'O ponto central: ninguém reiniciou nada manualmente. O circuito fechou sozinho depois do tempo configurado e o tráfego voltou a fluir. É a diferença entre "falhar rápido e se recuperar sozinho" vs. deixar o sistema inteiro travado esperando uma dependência quebrada — e por que isso importa tanto quanto o próprio timeout.',
      istioConfig:
        'DestinationRule "payment-db-dr": `outlierDetection.consecutive5xxErrors: 3`, `baseEjectionTime: 30s`, `maxEjectionPercent: 100`. Repare: rodar esse cenário (ou o de Timeout) mais de uma vez seguida pode fazer o Envoy aumentar o tempo de ejeção a cada vez (proteção contra "flapping") — o painel detecta isso e espera o ambiente ficar saudável antes de começar, mostrando uma nota explicando.'
    }
  },
  {
    id: 'auth-denied',
    title: '5. Authorization Denied',
    icon: '🚫',
    description: 'payment-queue tenta chamar payment-db diretamente — a AuthorizationPolicy deve bloquear (403).',
    path: 'auth-denied',
    streaming: false,
    estimatedDuration: '~1s',
    roteiro: {
      descricao:
        'O payment-queue tenta chamar o payment-db diretamente — algo que ele nunca deveria fazer no fluxo real de negócio — e o Istio bloqueia isso via identidade de serviço, mesmo a rede permitindo a conexão.',
      aposClique:
        'Por ~1 segundo: duas chamadas — uma pro payment-api (permitida, 200) e outra pro payment-db (bloqueada, 403 Forbidden).',
      explicar:
        'Este é Zero Trust em ação — a segurança não depende de "quem está na mesma rede pode acessar", e sim da identidade criptográfica (mTLS automático via ztunnel) de cada serviço. Mesmo estando no mesmo namespace, o payment-queue é negado porque a AuthorizationPolicy diz explicitamente que só quem tem a identidade certa pode falar com payment-db.',
      istioConfig:
        'AuthorizationPolicy "payment-queue-deny-db" (action: DENY, principal da SA payment-queue) + "payment-db-authz" (action: ALLOW, só SA default). Detalhe importante de Ambient Mode: essas políticas precisam ser anexadas ao WAYPOINT via `targetRefs` (não ao workload via `selector`) — anexadas ao workload, o ztunnel avalia a política vendo o waypoint como origem da conexão (não o chamador real) e rejeita tudo. Ver o menu de Ajuda para o detalhe completo.'
    }
  }
];

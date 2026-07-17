export interface HelpSection {
  title: string;
  icon: string;
  body: string[]; // cada item é um parágrafo/bloco
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Kiali',
    icon: '🕸️',
    body: [
      'O que é: a interface visual do Istio — mostra o grafo de tráfego entre os serviços em tempo real (ou quase). É a melhor ferramenta pra responder "o que está acontecendo AGORA".',
      'Como acessar: kubectl -n istio-system port-forward svc/kiali 20001:20001, depois abra http://localhost:20001. Não pede senha (autenticação anônima já vem configurada).',
      'Como usar: menu Graph → selecione o namespace "payment-hub" → em Display, ligue "Traffic Animation" → em Time range, use "Last 5m" (ou mais).',
      'Pegadinha: se o grafo aparecer vazio, quase sempre é porque não teve tráfego DENTRO da janela de tempo selecionada — gere tráfego (rode um cenário) antes de conferir, ou aumente o Time range.',
      'O que observar: setas verdes = sucesso; amarelas/vermelhas = erro ou latência alta; o número na aresta é taxa de requisições/s. Clique num nó pra ver métricas de entrada/saída daquele serviço específico.'
    ]
  },
  {
    title: 'Grafana',
    icon: '📈',
    body: [
      'O que é: dashboards de métricas HISTÓRICAS (série temporal), vindas do Prometheus. Enquanto o Kiali mostra "agora", o Grafana mostra "como isso se comportou ao longo do tempo" — ideal pra apontar um pico de latência ou uma taxa de erro que subiu durante um cenário específico.',
      'Como acessar: kubectl -n istio-system port-forward svc/grafana 3001:3000, depois abra http://localhost:3001. Login padrão: admin / admin (pode pular a troca de senha).',
      'Dashboards prontos: "Istio Mesh Dashboard" (visão geral de toda a malha — bom ponto de partida) e "Istio Control Plane Dashboard" (saúde do istiod). Busque por "Istio" no menu Dashboards se não aparecerem na tela inicial.',
      'Dica de aula: abra um dashboard filtrado pelo namespace "payment-hub" ANTES de rodar o Circuit Breaker — dá pra literalmente ver o gráfico de taxa de erro subir na Fase 1 e cair de volta na Fase 3, com a janela de 30s no meio.'
    ]
  },
  {
    title: 'Configuração Istio/Envoy por cenário',
    icon: '⚙️',
    body: [
      '① Timeout — VirtualService, campo http[].timeout. Define quanto tempo o Envoy espera uma resposta antes de desistir e devolver 504. Sem isso, uma dependência lenta trava o cliente indefinidamente.',
      '② Retry — VirtualService, campo http[].retries (attempts, perTryTimeout, retryOn). Tenta de novo automaticamente em caso de falha transitória — mas cuidado: retry agressivo demais AMPLIFICA carga numa dependência já sofrendo (aqui usamos só 3 tentativas, com perTryTimeout curto).',
      '③ Circuit Breaker — DestinationRule, trafficPolicy.outlierDetection: consecutive5xxErrors (quantas falhas seguidas até ejetar), interval (de quanto em quanto tempo o Envoy reavalia), baseEjectionTime (tempo mínimo ejetado), maxEjectionPercent (limite de quanto do pool pode ficar ejetado ao mesmo tempo). Ejeções repetidas AUMENTAM o tempo de ejeção a cada vez — proteção real contra "flapping", é por isso que rodar o cenário 2x seguidas pode parecer "diferente" da primeira vez.',
      '④ Backpressure — DestinationRule, trafficPolicy.connectionPool.http: http1MaxPendingRequests e maxRequestsPerConnection. Limitam quanto o MESH deixa passar antes de rejeitar — cuidado pra não configurar baixo demais e mascarar a lógica de fila do próprio aplicativo (foi exatamente esse ajuste que precisei fazer aqui: subir http1MaxPendingRequests de 10 pra 100 pra caber a rajada de teste).',
      '⑤ mTLS automático — PeerAuthentication, mode: STRICT. Em Ambient Mode, isso é aplicado pelo ztunnel (um proxy L4 por nó) sem precisar de sidecar em cada pod — toda comunicação passa a exigir certificado mútuo válido.',
      '⑥ Autorização (RBAC) — AuthorizationPolicy, action ALLOW/DENY + rules com source.principals (identidade do chamador, formato cluster.local/ns/NAMESPACE/sa/SERVICEACCOUNT) e operation.hosts/paths/ports (o quê e onde). Assim que QUALQUER policy ALLOW mira um destino, esse destino vira "negado por padrão" pra tudo que não bate com uma regra.',
      '⚠️ A pegadinha mais importante do Ambient Mode: se o namespace tem um waypoint (necessário pra regras L7, com paths/hosts), a AuthorizationPolicy precisa ser anexada a ELE via targetRefs (kind: Gateway, name: waypoint) — NÃO via selector no workload de destino. Anexada ao workload, o ztunnel do destino avalia a regra vendo o WAYPOINT como origem da conexão (não o chamador de verdade), e como a identidade não bate com nada configurado, ele nega tudo — inclusive tráfego que deveria ser permitido. Foi exatamente isso que quebrou payment-api e payment-queue neste projeto até corrigir pra targetRefs.',
      'Waypoint — em Ambient puro (só ztunnel) só dá pra fazer controle L4 (identidade, sem olhar path/método HTTP). Pra qualquer regra que precise "olhar dentro" da requisição HTTP (path, host, retries, timeout por rota), é preciso um waypoint (istioctl waypoint apply -n <namespace> --enroll-namespace) — é um proxy Envoy completo que processa L7 pros serviços daquele namespace.'
    ]
  }
];

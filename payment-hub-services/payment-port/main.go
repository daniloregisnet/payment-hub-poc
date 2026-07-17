package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// scenario-runner orquestra os 5 cenários de demonstração pra um painel de controle
// (Angular) conseguir dispará-los com um clique, em vez de digitar curl na mão.
//
// Roda dentro do namespace payment-hub com a MESMA ServiceAccount do settlement-queue
// (ver manifests) — assim ele naturalmente tem a identidade certa pra reproduzir o
// cenário de autorização negada sem precisar de kubectl exec: uma chamada direta daqui
// pra payment-db recebe o mesmo 403 que o settlement-queue real receberia.
//
// Todos os handlers respeitam r.Context(): se o cliente cancelar (botão "Cancelar" no
// painel, que aborta o fetch), o contexto da requisição é encerrado automaticamente pelo
// net/http, e os loops abaixo checam isso pra parar de martelar os outros serviços em vez
// de continuar rodando "no vácuo" depois que ninguém está mais olhando.

const (
	paymentAPI  = "http://payment-api"
	paymentDB   = "http://payment-db"
	settlementQ = "http://settlement-queue"
)

var httpClient = &http.Client{Timeout: 20 * time.Second}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/api/scenarios/happy-path", happyPathHandler)
	mux.HandleFunc("/api/scenarios/timeout-retry", timeoutRetryHandler)
	mux.HandleFunc("/api/scenarios/backpressure", backpressureHandler)
	mux.HandleFunc("/api/scenarios/circuit-breaker", circuitBreakerHandler)
	mux.HandleFunc("/api/scenarios/auth-denied", authDeniedHandler)

	log.Println("Scenario Runner listening on :8004")
	log.Fatal(http.ListenAndServe(":8004", withCORS(mux)))
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprint(w, "OK\n")
}

// ---------- helpers ----------

type reqResult struct {
	StatusCode int    `json:"statusCode"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
	Body       string `json:"body,omitempty"`
}

func doGet(ctx context.Context, url string) reqResult {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return reqResult{DurationMs: time.Since(start).Milliseconds(), Error: err.Error()}
	}
	resp, err := httpClient.Do(req)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		return reqResult{DurationMs: elapsed, Error: err.Error()}
	}
	defer resp.Body.Close()
	return reqResult{StatusCode: resp.StatusCode, DurationMs: elapsed}
}

func doPost(ctx context.Context, url string) reqResult {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return reqResult{DurationMs: time.Since(start).Milliseconds(), Error: err.Error()}
	}
	resp, err := httpClient.Do(req)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		return reqResult{DurationMs: elapsed, Error: err.Error()}
	}
	defer resp.Body.Close()
	return reqResult{StatusCode: resp.StatusCode, DurationMs: elapsed}
}

// sleepOrCancelled aguarda d, mas retorna cedo (false) se o cliente cancelar/desconectar —
// é o que faz o botão "Cancelar" do painel realmente interromper cedo os 30s de espera do
// Circuit Breaker, em vez de só parar de mostrar o resultado na tela.
func sleepOrCancelled(ctx context.Context, d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}

// sseWriter escreve um evento "data: <json>\n\n" e força o flush — sem isso o Angular
// só recebe tudo de uma vez no final, quando a conexão fecha.
func sseWriter(w http.ResponseWriter) (func(event string, payload any), bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	return func(event string, payload any) {
		b, _ := json.Marshal(payload)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(b))
		flusher.Flush()
	}, true
}

// ---------- Scenario 1: Happy Path ----------

func happyPathHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	const n = 10
	results := make([]reqResult, 0, n)
	var success int64
	var totalMs int64
	var executed int64

	for i := 0; i < n; i++ {
		if ctx.Err() != nil {
			break
		}
		res := doGet(ctx, paymentAPI+"/process-payment")
		results = append(results, res)
		executed++
		if res.StatusCode == http.StatusOK {
			atomic.AddInt64(&success, 1)
		}
		totalMs += res.DurationMs
	}

	if ctx.Err() != nil {
		return // cliente cancelou — não tem mais ninguém escutando a resposta
	}

	avg := int64(0)
	if executed > 0 {
		avg = totalMs / executed
	}

	writeJSON(w, map[string]any{
		"scenario":     "happy-path",
		"requests":     executed,
		"success":      success,
		"failed":       executed - success,
		"avgLatencyMs": avg,
		"results":      results,
	})
}

// ---------- Scenario 2: Timeout + Retry ----------

func timeoutRetryHandler(w http.ResponseWriter, r *http.Request) {
	send, ok := sseWriter(w)
	if !ok {
		writeJSON(w, map[string]string{"error": "streaming unsupported"})
		return
	}
	ctx := r.Context()

	send("start", map[string]any{"scenario": "timeout-retry", "requests": 3})

	for i := 1; i <= 3; i++ {
		if ctx.Err() != nil {
			return
		}
		res := doGet(ctx, paymentAPI+"/check-fraud?delay=15000")
		send("progress", map[string]any{
			"request":    i,
			"statusCode": res.StatusCode,
			"durationMs": res.DurationMs,
			"error":      res.Error,
			"note":       "timeout do VirtualService é 5s — o backend demora 15s de propósito",
		})
		if !sleepOrCancelled(ctx, 1*time.Second) {
			return
		}
	}

	send("done", map[string]any{"scenario": "timeout-retry"})
}

// ---------- Scenario 3: Backpressure ----------

func backpressureHandler(w http.ResponseWriter, r *http.Request) {
	send, ok := sseWriter(w)
	if !ok {
		writeJSON(w, map[string]string{"error": "streaming unsupported"})
		return
	}
	ctx := r.Context()

	const n = 100
	send("start", map[string]any{"scenario": "backpressure", "requests": n})

	var accepted, rejected, otherErr int64
	var mu sync.Mutex
	var wg sync.WaitGroup
	completed := 0

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			// doPost usa ctx — se o cliente cancelar, as chamadas em voo são abortadas
			// imediatamente em vez de completar sem ninguém escutando.
			res := doPost(ctx, settlementQ+"/enqueue-settlement")
			switch res.StatusCode {
			case http.StatusAccepted:
				atomic.AddInt64(&accepted, 1)
			case http.StatusTooManyRequests:
				atomic.AddInt64(&rejected, 1)
			default:
				atomic.AddInt64(&otherErr, 1)
			}

			mu.Lock()
			completed++
			if completed%10 == 0 || completed == n {
				send("progress", map[string]any{
					"completed": completed,
					"total":     n,
					"accepted":  atomic.LoadInt64(&accepted),
					"rejected":  atomic.LoadInt64(&rejected),
				})
			}
			mu.Unlock()
		}(i)
	}
	wg.Wait()

	if ctx.Err() != nil {
		return
	}

	statusRes := doGet(ctx, settlementQ+"/status")
	send("done", map[string]any{
		"scenario":    "backpressure",
		"accepted":    accepted,
		"rejected429": rejected,
		"otherErrors": otherErr,
		"queueStatus": statusRes.Body,
	})
}

// ---------- Scenario 4: Circuit Breaker ----------

func circuitBreakerHandler(w http.ResponseWriter, r *http.Request) {
	send, ok := sseWriter(w)
	if !ok {
		writeJSON(w, map[string]string{"error": "streaming unsupported"})
		return
	}
	ctx := r.Context()

	log.Println("[circuit-breaker] fase 1 iniciada")
	send("start", map[string]any{"scenario": "circuit-breaker"})

	send("phase", map[string]any{"phase": 1, "label": "Causando erros consecutivos no DB"})
	for i := 1; i <= 5; i++ {
		if ctx.Err() != nil {
			log.Println("[circuit-breaker] cancelado durante a fase 1")
			return
		}
		res := doGet(ctx, paymentAPI+"/check-fraud?error=true")
		send("progress", map[string]any{"phase": 1, "request": i, "statusCode": res.StatusCode, "durationMs": res.DurationMs})
		if !sleepOrCancelled(ctx, 1*time.Second) {
			log.Println("[circuit-breaker] cancelado durante o sleep da fase 1")
			return
		}
	}

	log.Println("[circuit-breaker] fase 2 (espera 30s) iniciada")
	send("phase", map[string]any{"phase": 2, "label": "Circuito aberto — aguardando baseEjectionTime (30s)"})
	for remaining := 30; remaining > 0; remaining -= 5 {
		send("progress", map[string]any{"phase": 2, "waitingSeconds": remaining})
		// É aqui que o "Cancelar" mais importa — sem checar ctx, o cenário ficaria
		// martelando 30s de espera no servidor mesmo com ninguém mais olhando o painel.
		if !sleepOrCancelled(ctx, 5*time.Second) {
			log.Println("[circuit-breaker] cancelado durante a fase 2 (espera)")
			return
		}
	}

	log.Println("[circuit-breaker] fase 3 (recuperação) iniciada")
	send("phase", map[string]any{"phase": 3, "label": "Testando recuperação"})
	for i := 1; i <= 3; i++ {
		if ctx.Err() != nil {
			log.Println("[circuit-breaker] cancelado durante a fase 3")
			return
		}
		res := doGet(ctx, paymentAPI+"/check-fraud")
		send("progress", map[string]any{"phase": 3, "request": i, "statusCode": res.StatusCode, "durationMs": res.DurationMs})
		if !sleepOrCancelled(ctx, 1*time.Second) {
			log.Println("[circuit-breaker] cancelado durante o sleep da fase 3")
			return
		}
	}

	log.Println("[circuit-breaker] concluído normalmente")
	send("done", map[string]any{"scenario": "circuit-breaker"})
}

// ---------- Scenario 5: Authorization Denied ----------

func authDeniedHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// scenario-runner roda com a ServiceAccount "settlement-queue" (ver manifests) — estas
	// chamadas são avaliadas pelas MESMAS AuthorizationPolicy que o settlement-queue real
	// enfrentaria, sem precisar de kubectl exec dentro do pod dele.
	toAPI := doGet(ctx, paymentAPI+"/process-payment")
	toDB := doGet(ctx, paymentDB+"/get-chargeback-history")

	if ctx.Err() != nil {
		return
	}

	writeJSON(w, map[string]any{
		"scenario": "auth-denied",
		"toPaymentApi": map[string]any{
			"statusCode": toAPI.StatusCode,
			"allowed":    toAPI.StatusCode == http.StatusOK,
		},
		"toPaymentDb": map[string]any{
			"statusCode": toDB.StatusCode,
			"allowed":    toDB.StatusCode == http.StatusOK,
			"denied":     toDB.StatusCode == http.StatusForbidden,
		},
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

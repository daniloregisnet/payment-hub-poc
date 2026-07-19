package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/check-transaction-history", checkHistoryHandler)
	http.HandleFunc("/get-card-limit", getCardLimitHandler)

	log.Println("Cache Service (Transaction Cache) listening on :8001")
	log.Fatal(http.ListenAndServe(":8001", nil))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK\n")
}

func checkHistoryHandler(w http.ResponseWriter, r *http.Request) {
	delay := r.URL.Query().Get("delay")
	errFlag := r.URL.Query().Get("error")

	if delay != "" {
		if d, err := strconv.Atoi(delay); err == nil {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}
	}

	if errFlag == "true" {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"cache unavailable"}\n`)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"cache","status":"ok","recent_transactions":5,"fraud_risk":"low","hit_rate":0.92}\n`)
}

func getCardLimitHandler(w http.ResponseWriter, r *http.Request) {
	// Repassa delay/error adiante (não aplica aqui) — quem deve simular lentidão/erro neste
	// cenário é o payment-db, não o cache.
	url := "http://payment-db/get-chargeback-history?" + r.URL.Query().Encode()
	resp, err := forward(r, url)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"failed to fetch from DB"}\n`)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	// Repassa o status real do DB (era sempre 200 antes, mesmo quando o DB respondia 500 —
	// isso escondia erro de propósito atrás de um "sucesso" no painel de demonstração).
	w.WriteHeader(resp.StatusCode)
	fmt.Fprintf(w, `{"service":"cache","card_limit":5000.00,"db_response":%s}`+"\n", jsonOrString(body))
}

// jsonOrString devolve body como está se já for JSON válido, ou o embrulha como string JSON
// caso contrário — sem isso, uma resposta não-JSON do DB (ex.: "no healthy upstream", que o
// Envoy devolve quando o destino está ejetado pelo circuit breaker) quebraria a sintaxe do
// JSON que este serviço monta.
func jsonOrString(body []byte) []byte {
	trimmed := bytes.TrimSpace(body)
	if json.Valid(trimmed) {
		return trimmed
	}
	quoted, _ := json.Marshal(string(body))
	return quoted
}

// traceHeaders lista os headers que precisam atravessar cada hop — sem repassar isso, o Envoy
// (ingressgateway/waypoint) não consegue juntar os spans de cada serviço num único trace, e cada
// hop vira uma árvore órfã no Jaeger.
var traceHeaders = []string{
	"x-request-id",
	"traceparent",
	"tracestate",
	"x-b3-traceid",
	"x-b3-spanid",
	"x-b3-parentspanid",
	"x-b3-sampled",
	"x-b3-flags",
	"b3",
	"x-ot-span-context",
	"x-cloud-trace-context",
	"grpc-trace-bin",
}

// forward cria uma requisição GET para url copiando os headers de trace do request de entrada,
// e a executa.
func forward(in *http.Request, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(in.Context(), http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	for _, h := range traceHeaders {
		if v := in.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	return http.DefaultClient.Do(req)
}

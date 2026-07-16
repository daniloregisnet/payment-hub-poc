package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

func main() {
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/process-payment", processPaymentHandler)
	http.HandleFunc("/check-fraud", checkFraudHandler)

	log.Println("Payment Hub API Service listening on :8000")
	log.Fatal(http.ListenAndServe(":8000", nil))
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "OK\n")
}

func processPaymentHandler(w http.ResponseWriter, r *http.Request) {
	delay := r.URL.Query().Get("delay")
	errFlag := r.URL.Query().Get("error")

	if delay != "" {
		if d, err := strconv.Atoi(delay); err == nil {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}
	}

	if errFlag == "true" {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"payment processing failed"}\n`)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"payment-api","status":"processing","transaction_id":"txn_12345","amount":100.00,"currency":"BRL"}\n`)
}

func checkFraudHandler(w http.ResponseWriter, r *http.Request) {
	// Repassa delay/error pra cadeia inteira (cache -> db) — check-fraud precisa alcançar o
	// payment-db pra valer pros cenários de Timeout/Circuit Breaker, que simulam "DB lento" e
	// "DB offline" especificamente (ver payment-db-dr em istio-config.yaml).
	url := "http://payment-cache/get-card-limit?" + r.URL.Query().Encode()
	resp, err := http.Get(url)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprintf(w, `{"error":"failed to check fraud database"}\n`)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"service":"payment-api","fraud_check":true,"cache_response":%s}\n`, string(body))
}
